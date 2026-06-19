const express = require("express");
const cors = require("cors");
const app = express();
const port = 5000;
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// ─── Stripe (Option 2: Checkout Sessions — No Webhook) ─────────────
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ─── Nodemailer (Dummy Transport for Email Notifications) ───────────
const nodemailer = require("nodemailer");

// Create a test account (ethereal.email) for dummy email transport
let dummyTransporter = null;
let dummyEmailAccount = null;

async function initDummyEmail() {
  try {
    dummyEmailAccount = await nodemailer.createTestAccount();
    dummyTransporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: {
        user: dummyEmailAccount.user,
        pass: dummyEmailAccount.pass,
      },
    });
    console.log("📧 Dummy Email transport initialized");
  } catch (err) {
    console.warn("⚠️  Dummy Email transport failed to init, falling back to console logging:", err.message);
  }
}
initDummyEmail();

// ─── Middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── MongoDB Connection (persistent) ─────────────────────────────────
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("legalEase_db");
    await db.command({ ping: 1 });
    console.log("✅ Connected to MongoDB — legalEase_db");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}
connectDB();

// ─── Auth Middleware ──────────────────────────────────────────────────
async function verifyUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ success: false, message: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const session = await db.collection("session").findOne({ token });
    if (!session) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Invalid or expired token",
      });
    }

    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      await db.collection("session").deleteOne({ _id: session._id });
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: Session expired" });
    }

    const user = await db
      .collection("user")
      .findOne({ _id: new ObjectId(session.userId) });
    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: User not found" });
    }

    // Check if user is blocked
    if (user.isBlocked) {
      await db.collection("session").deleteOne({ _id: session._id });
      return res.status(403).json({
        success: false,
        message: "Forbidden: Your account has been blocked. Contact an administrator.",
      });
    }

    req.user = user;
    req.sessionId = session._id;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
}

// ─── Admin Middleware ─────────────────────────────────────────────────
function verifyAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res
      .status(403)
      .json({ success: false, message: "Forbidden: Admin access required" });
  }
  next();
}

// ─── Health Check ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("LegalEase Backend is running!");
});

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES (No Auth Required)
// ═══════════════════════════════════════════════════════════════════════

// ─── API: Browse Lawyers (Public) ────────────────────────────────────
// GET /api/lawyers?search=&specialization=&availability=&minFee=&maxFee=&sort=&page=&limit=
app.get("/api/lawyers", async (req, res) => {
  try {
    const { search, specialization, availability, minFee, maxFee, sort } =
      req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 9));
    const skip = (page - 1) * limit;

    const SPEC_MAP = {
      criminal: "Criminal Law",
      corporate: "Corporate Law",
      family: "Family Law",
      "real-estate": "Real Estate",
      immigration: "Immigration",
      civil: "Civil Litigation",
      tax: "Tax Law",
      employment: "Employment Law",
      ip: "Intellectual Property",
      injury: "Personal Injury",
      bankruptcy: "Bankruptcy",
      constitutional: "Constitutional Law",
    };

    const match = { role: "lawyer" };

    if (search) {
      const regex = new RegExp(search, "i");
      match.$or = [
        { name: { $regex: regex } },
        { specialization: { $regex: regex } },
      ];
    }

    if (specialization) {
      const mapped = SPEC_MAP[specialization] || specialization;
      match.specialization = {
        $regex: new RegExp(
          `^${mapped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "i",
        ),
      };
    }

    if (availability === "available") {
      match.isAvailable = { $ne: false };
    } else if (availability === "busy") {
      match.isAvailable = false;
    }

    if (minFee || maxFee) {
      match.hourlyRate = {};
      if (minFee) match.hourlyRate.$gte = Number(minFee);
      if (maxFee) match.hourlyRate.$lte = Number(maxFee);
    }

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "comment",
          let: { lawyerIdStr: { $toString: "$_id" } },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$lawyerId", "$$lawyerIdStr"] },
              },
            },
            {
              $group: {
                _id: "$lawyerId",
                avgRating: { $avg: "$rating" },
                totalReviews: { $sum: 1 },
              },
            },
          ],
          as: "reviewStats",
        },
      },
      {
        $unwind: {
          path: "$reviewStats",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $addFields: {
          rating: {
            $ifNull: [{ $round: ["$reviewStats.avgRating", 1] }, 0],
          },
          reviews: {
            $ifNull: ["$reviewStats.totalReviews", 0],
          },
          status: {
            $cond: [{ $eq: ["$isAvailable", false] }, "busy", "available"],
          },
        },
      },
    ];

    const sortMap = {
      "rating-desc": { rating: -1 },
      "rating-asc": { rating: 1 },
      "fee-asc": { hourlyRate: 1 },
      "fee-desc": { hourlyRate: -1 },
      "reviews-desc": { reviews: -1 },
    };
    const sortObj = sortMap[sort] || { createdAt: -1 };
    pipeline.push({ $sort: sortObj });

    pipeline.push({
      $facet: {
        total: [{ $count: "count" }],
        lawyers: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              id: "$_id",
              name: 1,
              image: 1,
              specialization: 1,
              hourlyRate: 1,
              city: 1,
              location: 1,
              rating: 1,
              reviews: 1,
              status: 1,
            },
          },
        ],
      },
    });

    const result = await db.collection("user").aggregate(pipeline).toArray();
    const batch = result[0];
    const total = batch.total[0]?.count || 0;

    const lawyers = (batch.lawyers || []).map((l) => ({
      ...l,
      id: l.id.toString(),
      rating: Number(l.rating) || 0,
      hourlyRate: l.hourlyRate || 0,
      location: l.city || l.location || "",
    }));

    // ── Optional: enrich with isHired & isShortlisted for logged-in users ──
    // The auth header may be present from apiFetch, try to decode user
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const session = await db.collection("session").findOne({ token });
        if (session && !session.expiresAt || new Date(session.expiresAt) >= new Date()) {
          const userId = session.userId.toString();
          const lawyerIds = lawyers.map((l) => l.id);

          // Check hired (accepted or paid)
          const hirings = await db.collection("hiring").find({
            userId,
            lawyerId: { $in: lawyerIds },
            status: { $in: ["accepted", "paid"] },
          }).toArray();
          const hiredSet = new Set(hirings.map((h) => h.lawyerId));

          // Check shortlisted
          const shortlisted = await db.collection("shortlist").find({
            userId,
            lawyerId: { $in: lawyerIds },
          }).toArray();
          const shortlistSet = new Set(shortlisted.map((s) => s.lawyerId));

          lawyers.forEach((l) => {
            l.isHired = hiredSet.has(l.id);
            l.isShortlisted = shortlistSet.has(l.id);
          });
        }
      } catch {
        // silently ignore — public browsing still works
      }
    }

    return res.json({
      success: true,
      data: { lawyers, total },
    });
  } catch (err) {
    console.error("Error browsing lawyers:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch lawyers" });
  }
});

// ─── API: Get Featured Lawyers (Public) ──────────────────────────────
// GET /api/lawyers/featured
app.get("/api/lawyers/featured", async (req, res) => {
  try {
    const lawyers = await db
      .collection("user")
      .find({ role: "lawyer" })
      .project({
        name: 1,
        image: 1,
        specialization: 1,
        hourlyRate: 1,
        experience: 1,
        city: 1,
        location: 1,
        isAvailable: 1,
        bio: 1,
      })
      .toArray();

    if (lawyers.length === 0) {
      return res.json({ success: true, data: { lawyers: [] } });
    }

    const lawyerIds = lawyers.map((l) => l._id.toString());

    const reviewStats = await db
      .collection("comment")
      .aggregate([
        { $match: { lawyerId: { $in: lawyerIds } } },
        {
          $group: {
            _id: "$lawyerId",
            avgRating: { $avg: "$rating" },
            totalReviews: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const statsMap = {};
    reviewStats.forEach((s) => {
      statsMap[s._id] = {
        rating: Number(s.avgRating.toFixed(1)),
        totalReviews: s.totalReviews,
      };
    });

    const enriched = lawyers.map((l) => ({
      _id: l._id.toString(),
      name: l.name,
      image: l.image,
      specialization: l.specialization,
      hourlyRate: l.hourlyRate || 0,
      experience: l.experience || 0,
      city: l.city || l.location || "",
      location: l.location || "",
      isAvailable: l.isAvailable !== false,
      bio: l.bio,
      rating: statsMap[l._id.toString()]?.rating || 0,
      totalReviews: statsMap[l._id.toString()]?.totalReviews || 0,
    }));

    enriched.sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      return b.totalReviews - a.totalReviews;
    });

    return res.json({
      success: true,
      data: { lawyers: enriched.slice(0, 6) },
    });
  } catch (err) {
    console.error("Error fetching featured lawyers:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch featured lawyers" });
  }
});

// ─── API: Get Top Legal Experts (Public) ─────────────────────────────
// GET /api/lawyers/top-experts
app.get("/api/lawyers/top-experts", async (req, res) => {
  try {
    const hireCounts = await db
      .collection("hiring")
      .aggregate([
        { $match: { lawyerId: { $exists: true, $ne: "" } } },
        { $group: { _id: "$lawyerId", totalHires: { $sum: 1 } } },
        { $sort: { totalHires: -1 } },
        { $limit: 3 },
      ])
      .toArray();

    if (hireCounts.length === 0) {
      return res.json({ success: true, data: { lawyers: [] } });
    }

    const topLawyers = await Promise.all(
      hireCounts.map(async (h) => {
        const lawyer = await db.collection("user").findOne(
          { _id: new ObjectId(h._id) },
          {
            projection: {
              name: 1,
              image: 1,
              specialization: 1,
            },
          },
        );

        return {
          _id: h._id,
          name: lawyer?.name || "Unknown",
          image: lawyer?.image || null,
          specialization: lawyer?.specialization || "",
          totalHires: h.totalHires,
        };
      }),
    );

    return res.json({ success: true, data: { lawyers: topLawyers } });
  } catch (err) {
    console.error("Error fetching top experts:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch top experts" });
  }
});

// ─── API: Get Legal Categories with Lawyer Counts (Public) ───────────
// GET /api/lawyers/categories
app.get("/api/lawyers/categories", async (req, res) => {
  try {
    const categories = await db
      .collection("user")
      .aggregate([
        {
          $match: {
            role: "lawyer",
            specialization: { $exists: true, $ne: "", $ne: null },
          },
        },
        { $group: { _id: "$specialization", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    const result = categories.map((c) => ({
      name: c._id || "Other",
      count: c.count,
    }));

    return res.json({ success: true, data: { categories: result } });
  } catch (err) {
    console.error("Error fetching categories:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch categories" });
  }
});

// ─── API: Get My Hirings (Client) ────────────────────────────────────
// GET /api/hirings/my-hirings?limit=100
app.get("/api/hirings/my-hirings", verifyUser, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;

    const hirings = await db
      .collection("hiring")
      .find({ userId: req.user._id.toString() })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const enrichedHirings = await Promise.all(
      hirings.map(async (hiring) => {
        let lawyerName = "Unknown";
        let lawyerSpecialization = "N/A";

        if (hiring.lawyerId) {
          const lawyer = await db
            .collection("user")
            .findOne(
              { _id: new ObjectId(hiring.lawyerId) },
              { projection: { name: 1, specialization: 1 } },
            );
          if (lawyer) {
            lawyerName = lawyer.name || "Unknown";
            lawyerSpecialization = lawyer.specialization || "N/A";
          }
        }

        return {
          _id: hiring._id,
          userId: hiring.userId,
          lawyerId: hiring.lawyerId,
          lawyerName,
          lawyerSpecialization,
          budget: hiring.budget || 0,
          status: hiring.status || "pending",
          createdAt: hiring.createdAt,
        };
      }),
    );

    return res.json({ success: true, data: { hirings: enrichedHirings } });
  } catch (err) {
    console.error("Error fetching my hirings:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch hirings" });
  }
});

// ─── API: Get Lawyer Requests ────────────────────────────────────────
// GET /api/hirings/lawyer-requests
app.get("/api/hirings/lawyer-requests", verifyUser, async (req, res) => {
  try {
    const hirings = await db
      .collection("hiring")
      .find({ lawyerId: req.user._id.toString() })
      .sort({ createdAt: -1 })
      .toArray();

    const enriched = await Promise.all(
      hirings.map(async (hiring) => {
        let clientName = "Unknown";

        if (hiring.userId) {
          const client = await db
            .collection("user")
            .findOne(
              { _id: new ObjectId(hiring.userId) },
              { projection: { name: 1 } },
            );
          if (client) {
            clientName = client.name || "Unknown";
          }
        }

        return {
          _id: hiring._id,
          userId: hiring.userId,
          lawyerId: hiring.lawyerId,
          clientName,
          budget: hiring.budget || 0,
          status: hiring.status || "pending",
          createdAt: hiring.createdAt,
        };
      }),
    );

    return res.json({ success: true, data: { hirings: enriched } });
  } catch (err) {
    console.error("Error fetching lawyer requests:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch requests" });
  }
});

// ─── API: Create Hiring Request (Client) ────────────────────────────
// POST /api/hirings
app.post("/api/hirings", verifyUser, async (req, res) => {
  try {
    const { lawyerId, budget } = req.body;

    if (req.user.role !== "client") {
      return res
        .status(403)
        .json({ success: false, message: "Only clients can hire lawyers" });
    }

    if (!lawyerId) {
      return res
        .status(400)
        .json({ success: false, message: "Lawyer ID is required" });
    }

    const lawyer = await db.collection("user").findOne({
      _id: new ObjectId(lawyerId),
      role: "lawyer",
    });

    if (!lawyer) {
      return res
        .status(404)
        .json({ success: false, message: "Lawyer not found" });
    }

    const existing = await db.collection("hiring").findOne({
      userId: req.user._id.toString(),
      lawyerId: lawyerId,
      status: { $in: ["pending", "accepted"] },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "You already have an active hiring request with this lawyer",
      });
    }

    const hiring = {
      userId: req.user._id.toString(),
      lawyerId: lawyerId,
      budget: budget || lawyer.hourlyRate || 0,
      status: "pending",
      createdAt: new Date(),
    };

    const result = await db.collection("hiring").insertOne(hiring);

    // ── Dummy Email Notification ──
    sendDummyEmail({
      to: lawyer.email,
      subject: `New Hiring Request from ${req.user.name}`,
      body: `Hi ${lawyer.name},\n\nYou have received a new hiring request from ${req.user.name} (${req.user.email}).\nBudget: $${hiring.budget}\n\nPlease check your dashboard to accept or reject this request.\n\n— LegalEase Team`,
    });

    return res.json({
      success: true,
      message: "Hiring request sent successfully",
      data: { _id: result.insertedId },
    });
  } catch (err) {
    console.error("Error creating hiring:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create hiring request" });
  }
});

// ─── API: Accept / Reject Hiring Request ─────────────────────────────
// PATCH /api/hirings/:id/accept   or   PATCH /api/hirings/:id/reject
app.patch("/api/hirings/:id/:action", verifyUser, async (req, res) => {
  try {
    // Role check: only lawyers can accept/reject
    if (req.user.role !== "lawyer") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only lawyers can accept or reject hiring requests",
      });
    }

    const { id, action } = req.params;

    if (action !== "accept" && action !== "reject") {
      return res.status(400).json({
        success: false,
        message: "Invalid action. Use 'accept' or 'reject'.",
      });
    }

    const newStatus = action === "accept" ? "accepted" : "rejected";

    const result = await db.collection("hiring").updateOne(
      {
        _id: new ObjectId(id),
        lawyerId: req.user._id.toString(),
        status: "pending",
      },
      { $set: { status: newStatus, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Request not found or already acted on",
      });
    }

    // ── Dummy Email Notification ──
    const hiring = await db.collection("hiring").findOne({ _id: new ObjectId(id) });
    if (hiring) {
      const client = await db.collection("user").findOne({ _id: new ObjectId(hiring.userId) });
      if (client) {
        sendDummyEmail({
          to: client.email,
          subject: action === "accept" ? `Hiring Accepted by ${req.user.name}` : `Hiring Update from ${req.user.name}`,
          body: action === "accept"
            ? `Hi ${client.name},\n\nGreat news! Lawyer ${req.user.name} has accepted your hiring request.\nPlease proceed to payment from your hiring history page.\n\n— LegalEase Team`
            : `Hi ${client.name},\n\nUnfortunately, lawyer ${req.user.name} has declined your hiring request.\nYou can browse other lawyers and try again.\n\n— LegalEase Team`,
        });
      }
    }

    return res.json({ success: true, message: `Request ${newStatus}` });
  } catch (err) {
    console.error(`Error ${req.params.action}ing request:`, err);
    return res.status(500).json({
      success: false,
      message: `Failed to ${req.params.action} request`,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PAYMENT ROUTES (Stripe Checkout Sessions — No Webhook Needed)
// ═══════════════════════════════════════════════════════════════════════

// ─── API: Create Stripe Checkout Session ─────────────────────────────
// POST /api/payments/create-checkout
app.post("/api/payments/create-checkout", verifyUser, async (req, res) => {
  try {
    const { hiringId } = req.body;

    if (!hiringId) {
      return res
        .status(400)
        .json({ success: false, message: "Hiring ID is required" });
    }

    const hiring = await db.collection("hiring").findOne({
      _id: new ObjectId(hiringId),
      userId: req.user._id.toString(),
      status: "accepted",
    });

    if (!hiring) {
      return res.status(404).json({
        success: false,
        message: "Hiring not found or not eligible for payment",
      });
    }

    if (!hiring.budget || hiring.budget <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment amount" });
    }

    const lawyer = hiring.lawyerId
      ? await db
          .collection("user")
          .findOne(
            { _id: new ObjectId(hiring.lawyerId) },
            { projection: { name: 1 } },
          )
      : null;

    const lawyerName = lawyer?.name || "Lawyer";
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Legal Consultation — ${lawyerName}`,
              description: `Hiring ID: ${hiringId}`,
            },
            unit_amount: Math.round(hiring.budget * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/dashboard/client/hiring-history`,
      client_reference_id: hiringId,
      metadata: {
        hiringId: hiringId,
        userId: req.user._id.toString(),
        lawyerId: hiring.lawyerId || "",
      },
    });

    return res.json({
      success: true,
      data: { url: session.url, sessionId: session.id },
    });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create checkout session" });
  }
});

// ─── API: Verify Payment Status ──────────────────────────────────────
// GET /api/payments/status/:sessionId
app.get("/api/payments/status/:sessionId", verifyUser, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === "paid") {
      const hiringId = session.metadata?.hiringId;
      if (hiringId) {
        const hiring = await db.collection("hiring").findOne({ _id: new ObjectId(hiringId) });
        const wasAlreadyPaid = hiring && hiring.status === "paid";

        await db.collection("hiring").updateOne(
          { _id: new ObjectId(hiringId), userId: req.user._id.toString() },
          {
            $set: {
              status: "paid",
              paidAt: new Date(),
              stripeSessionId: sessionId,
              updatedAt: new Date(),
            },
          },
        );

        // ── Dummy Email: Payment Confirmation (only on first verification) ──
        if (!wasAlreadyPaid && hiring) {
          const lawyer = await db.collection("user").findOne({ _id: new ObjectId(hiring.lawyerId) });
          if (lawyer) {
            sendDummyEmail({
              to: lawyer.email,
              subject: `Payment Received from ${req.user.name}`,
              body: `Hi ${lawyer.name},\n\nPayment of $${session.amount_total / 100} has been received from client ${req.user.name} (${req.user.email}).\n\nPlease proceed with the consultation.\n\n— LegalEase Team`,
            });
          }
          sendDummyEmail({
            to: req.user.email,
            subject: `Payment Confirmation — LegalEase`,
            body: `Hi ${req.user.name},\n\nYour payment of $${session.amount_total / 100} for the hiring of ${lawyer?.name || "your lawyer"} has been confirmed.\n\nThank you for using LegalEase!\n\n— LegalEase Team`,
          });
        }
      }

      return res.json({
        success: true,
        data: {
          status: "paid",
          stripePaymentStatus: session.payment_status,
          amount: session.amount_total / 100,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        status: session.payment_status,
        stripePaymentStatus: session.payment_status,
      },
    });
  } catch (err) {
    console.error("Error verifying payment:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to verify payment" });
  }
});

// ─── API: Get Lawyer Profile ─────────────────────────────────────────
// GET /api/lawyers/profile
app.get("/api/lawyers/profile", verifyUser, async (req, res) => {
  try {
    // Role check: only lawyers
    if (req.user.role !== "lawyer") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: This endpoint is for lawyers only",
      });
    }

    const user = await db.collection("user").findOne(
      { _id: req.user._id },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          specialization: 1,
          bio: 1,
          hourlyRate: 1,
          phone: 1,
          barLicenseNumber: 1,
          experience: 1,
          education: 1,
          languages: 1,
          location: 1,
          city: 1,
          achievements: 1,
          fee: 1,
          isAvailable: 1,
          createdAt: 1,
        },
      },
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Profile not found" });
    }

    const reviewStats = await db
      .collection("comment")
      .aggregate([
        { $match: { lawyerId: req.user._id.toString() } },
        {
          $group: {
            _id: null,
            avgRating: { $avg: "$rating" },
            total: { $sum: 1 },
          },
        },
      ])
      .toArray();

    return res.json({
      success: true,
      data: {
        ...user,
        rating: reviewStats[0]?.avgRating
          ? Number(reviewStats[0].avgRating.toFixed(1))
          : 0,
        totalReviews: reviewStats[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error("Error fetching lawyer profile:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch profile" });
  }
});

// ─── API: Update Lawyer Profile ──────────────────────────────────────
// PUT /api/lawyers/profile
app.put("/api/lawyers/profile", verifyUser, async (req, res) => {
  try {
    // Role check: only lawyers
    if (req.user.role !== "lawyer") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: This endpoint is for lawyers only",
      });
    }

    const {
      name,
      image,
      specialization,
      bio,
      hourlyRate,
      phone,
      barLicenseNumber,
      experience,
      education,
      languages,
      location,
      city,
      achievements,
    } = req.body;

    if (!name || !name.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required" });
    }

    const updateFields = {
      name: name.trim(),
      updatedAt: new Date(),
    };

    if (image !== undefined) updateFields.image = image;
    if (specialization !== undefined)
      updateFields.specialization = specialization;
    if (bio !== undefined) updateFields.bio = bio;
    if (hourlyRate !== undefined)
      updateFields.hourlyRate = Number(hourlyRate) || 0;
    if (phone !== undefined) updateFields.phone = phone;
    if (barLicenseNumber !== undefined)
      updateFields.barLicenseNumber = barLicenseNumber;
    if (experience !== undefined)
      updateFields.experience = Number(experience) || 0;
    if (education !== undefined)
      updateFields.education = Array.isArray(education) ? education : [];
    if (languages !== undefined)
      updateFields.languages = Array.isArray(languages) ? languages : [];
    if (location !== undefined) updateFields.location = location;
    if (city !== undefined) updateFields.city = city;
    if (achievements !== undefined)
      updateFields.achievements = Array.isArray(achievements)
        ? achievements
        : [];

    const result = await db
      .collection("user")
      .updateOne({ _id: req.user._id }, { $set: updateFields });

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    return res.json({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (err) {
    console.error("Error updating lawyer profile:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update profile" });
  }
});

// ─── API: Create Comment / Review (Client) ──────────────────────────
// POST /api/comments
app.post("/api/comments", verifyUser, async (req, res) => {
  try {
    const { lawyerId, text, rating } = req.body;

    if (!lawyerId || !text || !rating) {
      return res.status(400).json({
        success: false,
        message: "lawyerId, text, and rating are required",
      });
    }

    if (req.user.role !== "client") {
      return res
        .status(403)
        .json({ success: false, message: "Only clients can leave reviews" });
    }

    if (!ObjectId.isValid(lawyerId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lawyer ID" });
    }

    // Check if lawyer exists
    const lawyer = await db.collection("user").findOne({
      _id: new ObjectId(lawyerId),
      role: "lawyer",
    });
    if (!lawyer) {
      return res
        .status(404)
        .json({ success: false, message: "Lawyer not found" });
    }

    // Check if user already commented on this lawyer
    const existing = await db.collection("comment").findOne({
      userId: req.user._id.toString(),
      lawyerId,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You have already reviewed this lawyer",
      });
    }

    // Check if user has hired this lawyer (accepted or paid)
    const hiringRecord = await db.collection("hiring").findOne({
      userId: req.user._id.toString(),
      lawyerId,
      status: { $in: ["accepted", "paid"] },
    });
    if (!hiringRecord) {
      return res.status(403).json({
        success: false,
        message: "Only clients who have hired this lawyer can leave a review",
      });
    }

    const comment = {
      userId: req.user._id.toString(),
      lawyerId,
      text: text.trim(),
      rating: Number(rating),
      createdAt: new Date(),
    };

    const result = await db.collection("comment").insertOne(comment);

    return res.status(201).json({
      success: true,
      message: "Review submitted successfully",
      data: { _id: result.insertedId, ...comment },
    });
  } catch (err) {
    console.error("Error creating comment:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to submit review" });
  }
});

// ─── API: Get My Comments ────────────────────────────────────────────
// GET /api/comments/my-comments
app.get("/api/comments/my-comments", verifyUser, async (req, res) => {
  try {
    const comments = await db
      .collection("comment")
      .find({ userId: req.user._id.toString() })
      .sort({ createdAt: -1 })
      .toArray();

    const enrichedComments = await Promise.all(
      comments.map(async (comment) => {
        let lawyerName = "Unknown";
        let lawyerSpecialization = "N/A";

        if (comment.lawyerId) {
          const lawyer = await db
            .collection("user")
            .findOne(
              { _id: new ObjectId(comment.lawyerId) },
              { projection: { name: 1, specialization: 1 } },
            );
          if (lawyer) {
            lawyerName = lawyer.name || "Unknown";
            lawyerSpecialization = lawyer.specialization || "N/A";
          }
        }

        return {
          _id: comment._id,
          userId: comment.userId,
          lawyerId: comment.lawyerId,
          lawyerName,
          lawyerSpecialization,
          text: comment.text || "",
          rating: comment.rating || 0,
          createdAt: comment.createdAt,
        };
      }),
    );

    return res.json({ success: true, data: enrichedComments });
  } catch (err) {
    console.error("Error fetching my comments:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch comments" });
  }
});

// ─── API: Update a Comment ───────────────────────────────────────────
// PUT /api/comments/:id
app.put("/api/comments/:id", verifyUser, async (req, res) => {
  try {
    const { text, rating } = req.body;

    const result = await db
      .collection("comment")
      .updateOne(
        { _id: new ObjectId(req.params.id), userId: req.user._id.toString() },
        { $set: { text, rating, updatedAt: new Date() } },
      );

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Comment not found" });
    }

    return res.json({ success: true, message: "Comment updated" });
  } catch (err) {
    console.error("Error updating comment:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update comment" });
  }
});

// ─── API: Delete a Comment ───────────────────────────────────────────
// DELETE /api/comments/:id
app.delete("/api/comments/:id", verifyUser, async (req, res) => {
  try {
    const result = await db.collection("comment").deleteOne({
      _id: new ObjectId(req.params.id),
      userId: req.user._id.toString(),
    });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Comment not found" });
    }

    return res.json({ success: true, message: "Comment deleted" });
  } catch (err) {
    console.error("Error deleting comment:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete comment" });
  }
});

// ─── API: Update User Profile (Client) ───────────────────────────────
// PUT /api/users/update-profile
app.put("/api/users/update-profile", verifyUser, async (req, res) => {
  try {
    const { name, image } = req.body;

    if (!name || !name.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required" });
    }

    const updateFields = {
      name: name.trim(),
      updatedAt: new Date(),
    };

    if (image) {
      updateFields.image = image;
    }

    const result = await db
      .collection("user")
      .updateOne({ _id: req.user._id }, { $set: updateFields });

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    return res.json({
      success: true,
      message: "Profile updated",
      data: { name: name.trim(), image: image || req.user.image },
    });
  } catch (err) {
    console.error("Error updating profile:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update profile" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// LAWYER SERVICES CRUD (Lawyer only)
// ═══════════════════════════════════════════════════════════════════════

// ─── API: Get Lawyer Services ──────────────────────────────────────
// GET /api/lawyers/services
app.get("/api/lawyers/services", verifyUser, async (req, res) => {
  try {
    if (req.user.role !== "lawyer") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: This endpoint is for lawyers only",
      });
    }

    const services = await db
      .collection("service")
      .find({ lawyerId: req.user._id.toString() })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({ success: true, data: services });
  } catch (err) {
    console.error("Error fetching lawyer services:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch services" });
  }
});

// ─── API: Create a Service ─────────────────────────────────────────
// POST /api/lawyers/services
app.post("/api/lawyers/services", verifyUser, async (req, res) => {
  try {
    if (req.user.role !== "lawyer") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only lawyers can create services",
      });
    }

    const { name, description, fee, specialization } = req.body;

    if (!name || !name.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Service name is required" });
    }

    const service = {
      lawyerId: req.user._id.toString(),
      name: name.trim(),
      description: (description || "").trim(),
      fee: Number(fee) || 0,
      specialization: specialization || "Criminal Law",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("service").insertOne(service);

    return res.status(201).json({
      success: true,
      message: "Service created successfully",
      data: { _id: result.insertedId, ...service },
    });
  } catch (err) {
    console.error("Error creating service:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create service" });
  }
});

// ─── API: Update a Service ─────────────────────────────────────────
// PUT /api/lawyers/services/:id
app.put("/api/lawyers/services/:id", verifyUser, async (req, res) => {
  try {
    if (req.user.role !== "lawyer") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only lawyers can update services",
      });
    }

    const { name, description, fee, specialization } = req.body;
    const serviceId = req.params.id;

    const existing = await db.collection("service").findOne({
      _id: new ObjectId(serviceId),
      lawyerId: req.user._id.toString(),
    });

    if (!existing) {
      return res
        .status(404)
        .json({ success: false, message: "Service not found" });
    }

    const updateFields = { updatedAt: new Date() };
    if (name !== undefined) updateFields.name = name.trim();
    if (description !== undefined) updateFields.description = description.trim();
    if (fee !== undefined) updateFields.fee = Number(fee) || 0;
    if (specialization !== undefined) updateFields.specialization = specialization;

    await db
      .collection("service")
      .updateOne(
        { _id: new ObjectId(serviceId) },
        { $set: updateFields },
      );

    return res.json({
      success: true,
      message: "Service updated successfully",
    });
  } catch (err) {
    console.error("Error updating service:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update service" });
  }
});

// ─── API: Delete a Service ─────────────────────────────────────────
// DELETE /api/lawyers/services/:id
app.delete("/api/lawyers/services/:id", verifyUser, async (req, res) => {
  try {
    if (req.user.role !== "lawyer") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Only lawyers can delete services",
      });
    }

    const result = await db.collection("service").deleteOne({
      _id: new ObjectId(req.params.id),
      lawyerId: req.user._id.toString(),
    });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Service not found" });
    }

    return res.json({
      success: true,
      message: "Service deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting service:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete service" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ─── API: Get All Users (Admin) ──────────────────────────────────────
// GET /api/admin/users
app.get("/api/admin/users", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const users = await db
      .collection("user")
      .find({})
      .sort({ createdAt: -1 })
      .project({
        name: 1,
        email: 1,
        role: 1,
        isBlocked: 1,
        image: 1,
        createdAt: 1,
      })
      .toArray();

    const roleCounts = { client: 0, lawyer: 0, admin: 0 };
    users.forEach((u) => {
      const r = u.role || "client";
      if (roleCounts[r] !== undefined) roleCounts[r]++;
    });

    return res.json({
      success: true,
      data: { users, roleCounts },
    });
  } catch (err) {
    console.error("Error fetching users:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch users" });
  }
});

// ─── API: Block / Unblock User (Admin) ───────────────────────────────
// PATCH /api/admin/users/:id/block
app.patch(
  "/api/admin/users/:id/block",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { isBlocked } = req.body;
      const userId = req.params.id;

      if (userId === req.user._id.toString()) {
        return res
          .status(400)
          .json({ success: false, message: "You cannot block yourself" });
      }

      const targetUser = await db
        .collection("user")
        .findOne({ _id: new ObjectId(userId) });
      if (!targetUser) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }
      if (targetUser.role === "admin") {
        return res
          .status(400)
          .json({ success: false, message: "Cannot block an admin" });
      }

      await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(userId) },
          { $set: { isBlocked: !!isBlocked, updatedAt: new Date() } },
        );

      return res.json({
        success: true,
        message: `User ${isBlocked ? "blocked" : "unblocked"}`,
      });
    } catch (err) {
      console.error("Error blocking user:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to update user" });
    }
  },
);

// ─── API: Change User Role (Admin) ───────────────────────────────────
// PATCH /api/admin/users/:id/role
app.patch(
  "/api/admin/users/:id/role",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { role } = req.body;
      const userId = req.params.id;

      if (!["client", "lawyer", "admin"].includes(role)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid role" });
      }

      if (userId === req.user._id.toString()) {
        return res
          .status(400)
          .json({ success: false, message: "You cannot change your own role" });
      }

      const result = await db
        .collection("user")
        .updateOne(
          { _id: new ObjectId(userId) },
          { $set: { role, updatedAt: new Date() } },
        );

      if (result.matchedCount === 0) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      return res.json({
        success: true,
        message: `Role updated to ${role}`,
      });
    } catch (err) {
      console.error("Error changing role:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to change role" });
    }
  },
);

// ─── API: Delete User (Admin) ────────────────────────────────────────
// DELETE /api/admin/users/:id
app.delete(
  "/api/admin/users/:id",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const userId = req.params.id;

      if (userId === req.user._id.toString()) {
        return res
          .status(400)
          .json({ success: false, message: "You cannot delete yourself" });
      }

      const oid = new ObjectId(userId);
      await db.collection("session").deleteMany({ userId });
      await db.collection("comment").deleteMany({ userId });
      await db.collection("hiring").deleteMany({ userId });
      await db.collection("hiring").deleteMany({ lawyerId: userId });

      const result = await db.collection("user").deleteOne({ _id: oid });

      if (result.deletedCount === 0) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      return res.json({
        success: true,
        message: "User deleted successfully",
      });
    } catch (err) {
      console.error("Error deleting user:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to delete user" });
    }
  },
);

// ─── API: Get All Transactions (Admin) ───────────────────────────────
// GET /api/admin/transactions?status=all|completed|pending|failed
app.get(
  "/api/admin/transactions",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { status } = req.query;

      const filter = {};
      if (status && status !== "all") {
        const statusMap = {
          completed: "paid",
          failed: "rejected",
        };
        filter.status = statusMap[status] || status;
      } else {
        // When "all", only show paid + rejected (actual transactions), skip pending/accepted
        filter.status = { $in: ["paid", "rejected"] };
      }

      const hirings = await db
        .collection("hiring")
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      const transactions = await Promise.all(
        hirings.map(async (hiring) => {
          let clientEmail = "N/A";
          let lawyerEmail = "N/A";

          if (hiring.userId) {
            const client = await db
              .collection("user")
              .findOne(
                { _id: new ObjectId(hiring.userId) },
                { projection: { email: 1 } },
              );
            if (client) clientEmail = client.email;
          }

          if (hiring.lawyerId) {
            const lawyer = await db
              .collection("user")
              .findOne(
                { _id: new ObjectId(hiring.lawyerId) },
                { projection: { email: 1 } },
              );
            if (lawyer) lawyerEmail = lawyer.email;
          }

          let txnStatus = "pending";
          if (hiring.status === "paid")
            txnStatus = "completed";
          else if (hiring.status === "rejected") txnStatus = "failed";

          return {
            transactionId: hiring._id.toString(),
            clientEmail,
            lawyerEmail,
            amount: hiring.budget || 0,
            status: txnStatus,
            createdAt: hiring.createdAt,
          };
        }),
      );

      const totalAmount = transactions
        .filter((t) => t.status === "completed")
        .reduce((sum, t) => sum + t.amount, 0);

      return res.json({
        success: true,
        data: { transactions, totalAmount },
      });
    } catch (err) {
      console.error("Error fetching transactions:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch transactions" });
    }
  },
);

// ─── API: Get Admin Stats (Admin) ────────────────────────────────────
// GET /api/admin/stats
app.get("/api/admin/stats", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const [totalUsers, totalLawyers, totalHires, acceptedHires, paidHires] =
      await Promise.all([
        db.collection("user").countDocuments({ role: { $in: ["client", "admin"] } }),
        db.collection("user").countDocuments({ role: { $in: ["lawyer"] } }),
        db.collection("hiring").countDocuments({}),
        db.collection("hiring").countDocuments({ status: "accepted" }),
        db.collection("hiring").countDocuments({ status: "paid" }),
      ]);

    const revenueAgg = await db
      .collection("hiring")
      .aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$budget" } } },
      ])
      .toArray();
    const totalRevenue = revenueAgg[0]?.total || 0;

    return res.json({
      success: true,
      data: {
        totalUsers,
        totalLawyers,
        totalHires,
        totalRevenue,
        paidHires,
      },
    });
  } catch (err) {
    console.error("Error fetching admin stats:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch stats" });
  }
});

// ─── API: Get Admin Analytics (Admin) ────────────────────────────────
// GET /api/admin/analytics
app.get("/api/admin/analytics", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const now = new Date();
    const months = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const label = d.toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
      });
      months.push({ start, end, month: label });
    }

    const monthlyUsers = await Promise.all(
      months.map(async (m) => {
        const count = await db.collection("user").countDocuments({
          createdAt: { $gte: m.start, $lt: m.end },
        });
        return { month: m.month, value: count };
      }),
    );

    const monthlyHires = await Promise.all(
      months.map(async (m) => {
        const count = await db.collection("hiring").countDocuments({
          createdAt: { $gte: m.start, $lt: m.end },
        });
        return { month: m.month, value: count };
      }),
    );

    const monthlyRevenue = await Promise.all(
      months.map(async (m) => {
        const agg = await db
          .collection("hiring")
          .aggregate([
            {
              $match: {
                status: "paid",
                createdAt: { $gte: m.start, $lt: m.end },
              },
            },
            { $group: { _id: null, total: { $sum: "$budget" } } },
          ])
          .toArray();
        return { month: m.month, value: agg[0]?.total || 0 };
      }),
    );

    const topSpecs = await db
      .collection("user")
      .aggregate([
        {
          $match: {
            role: "lawyer",
            specialization: { $exists: true, $ne: "" },
          },
        },
        { $group: { _id: "$specialization", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ])
      .toArray();

    const topSpecializations = topSpecs.map((s) => ({
      name: s._id || "Other",
      count: s.count,
    }));

    return res.json({
      success: true,
      data: {
        monthlyUsers,
        monthlyHires,
        monthlyRevenue,
        topSpecializations,
      },
    });
  } catch (err) {
    console.error("Error fetching analytics:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch analytics" });
  }
});

// ─── Dummy Email Notification Helper (Nodemailer + Ethereal) ─────
async function sendDummyEmail({ to, subject, body }) {
  // Always log to console
  console.log(`\n📧 DUMMY EMAIL SENT:`);
  console.log(`   To: ${to}`);
  console.log(`   Subject: ${subject}`);
  console.log(`   Body: ${body}`);
  console.log(`   Timestamp: ${new Date().toISOString()}\n`);

  // Send via Ethereal (test email service) if transporter is available
  if (dummyTransporter && dummyEmailAccount) {
    try {
      const info = await dummyTransporter.sendMail({
        from: `"LegalEase" <${dummyEmailAccount.user}>`,
        to,
        subject,
        text: body,
      });
      console.log(`   ✅ Ethereal Preview URL: ${nodemailer.getTestMessageUrl(info)}`);
    } catch (err) {
      console.warn(`   ⚠️  Ethereal send failed: ${err.message}`);
    }
  }
}

// ─── API: Shortlist (Client) ───────────────────────────────────────
// GET /api/shortlist — get user's shortlisted lawyers
app.get("/api/shortlist", verifyUser, async (req, res) => {
  try {
    const shortlist = await db
      .collection("shortlist")
      .find({ userId: req.user._id.toString() })
      .sort({ createdAt: -1 })
      .toArray();

    // Enrich with lawyer details
    const lawyers = await Promise.all(
      shortlist.map(async (s) => {
        const lawyer = await db
          .collection("user")
          .findOne(
            { _id: new ObjectId(s.lawyerId), role: "lawyer" },
            { projection: { name: 1, image: 1, specialization: 1, hourlyRate: 1, city: 1, location: 1, rating: 1 } },
          );
        if (!lawyer) return null;

        // Check review stats
        const reviewAgg = await db
          .collection("comment")
          .aggregate([
            { $match: { lawyerId: s.lawyerId } },
            { $group: { _id: null, avgRating: { $avg: "$rating" }, total: { $sum: 1 } } },
          ])
          .toArray();

        return {
          _id: s._id.toString(),
          lawyerId: s.lawyerId,
          addedAt: s.createdAt,
          name: lawyer.name,
          image: lawyer.image,
          specialization: lawyer.specialization,
          hourlyRate: lawyer.hourlyRate || 0,
          location: lawyer.city || lawyer.location || "",
          rating: Math.round((reviewAgg[0]?.avgRating || 0) * 10) / 10,
          reviews: reviewAgg[0]?.total || 0,
        };
      }),
    );

    return res.json({
      success: true,
      data: { shortlist: lawyers.filter(Boolean) },
    });
  } catch (err) {
    console.error("Error fetching shortlist:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch shortlist" });
  }
});

// POST /api/shortlist — add lawyer to shortlist
app.post("/api/shortlist", verifyUser, async (req, res) => {
  try {
    const { lawyerId } = req.body;
    if (!lawyerId) {
      return res.status(400).json({
        success: false,
        message: "Lawyer ID is required",
      });
    }

    const lawyer = await db.collection("user").findOne({
      _id: new ObjectId(lawyerId),
      role: "lawyer",
    });
    if (!lawyer) {
      return res.status(404).json({
        success: false,
        message: "Lawyer not found",
      });
    }

    const existing = await db.collection("shortlist").findOne({
      userId: req.user._id.toString(),
      lawyerId,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Already in shortlist",
      });
    }

    await db.collection("shortlist").insertOne({
      userId: req.user._id.toString(),
      lawyerId,
      createdAt: new Date(),
    });

    return res.json({
      success: true,
      message: "Added to shortlist",
    });
  } catch (err) {
    console.error("Error adding to shortlist:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to add to shortlist" });
  }
});

// DELETE /api/shortlist/:lawyerId — remove from shortlist
app.delete("/api/shortlist/:lawyerId", verifyUser, async (req, res) => {
  try {
    const result = await db.collection("shortlist").deleteOne({
      userId: req.user._id.toString(),
      lawyerId: req.params.lawyerId,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Not found in shortlist",
      });
    }

    return res.json({
      success: true,
      message: "Removed from shortlist",
    });
  } catch (err) {
    console.error("Error removing from shortlist:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to remove from shortlist" });
  }
});

// ─── API: Get Lawyer Details (Public) ────────────────────────────────
// GET /api/lawyers/:id
// Returns lawyer profile, review stats, total hires, and comments
app.get("/api/lawyers/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid lawyer ID" });
    }

    // Fetch lawyer profile
    const lawyer = await db.collection("user").findOne(
      { _id: new ObjectId(id), role: "lawyer" },
      {
        projection: {
          name: 1,
          image: 1,
          specialization: 1,
          bio: 1,
          hourlyRate: 1,
          phone: 1,
          barLicenseNumber: 1,
          experience: 1,
          education: 1,
          languages: 1,
          location: 1,
          city: 1,
          achievements: 1,
          isAvailable: 1,
          createdAt: 1,
        },
      },
    );

    if (!lawyer) {
      return res
        .status(404)
        .json({ success: false, message: "Lawyer not found" });
    }

    // Get review stats
    const reviewStats = await db
      .collection("comment")
      .aggregate([
        { $match: { lawyerId: id } },
        {
          $group: {
            _id: null,
            avgRating: { $avg: "$rating" },
            totalReviews: { $sum: 1 },
          },
        },
      ])
      .toArray();

    // Get total hires count (accepted only)
    const totalHires = await db.collection("hiring").countDocuments({
      lawyerId: id,
      status: "accepted",
    });

    // Get comments with commenter names
    const comments = await db
      .collection("comment")
      .find({ lawyerId: id })
      .sort({ createdAt: -1 })
      .toArray();

    const enrichedComments = await Promise.all(
      comments.map(async (comment) => {
        let userName = "Unknown";
        let userImage = null;

        if (comment.userId) {
          try {
            const commenter = await db
              .collection("user")
              .findOne(
                { _id: new ObjectId(comment.userId) },
                { projection: { name: 1, image: 1 } },
              );
            if (commenter) {
              userName = commenter.name || "Unknown";
              userImage = commenter.image || null;
            }
          } catch {
            // invalid userId, skip
          }
        }

        return {
          _id: comment._id.toString(),
          userId: comment.userId,
          userName,
          userImage,
          text: comment.text || "",
          rating: comment.rating || 0,
          date: comment.createdAt,
        };
      }),
    );

    return res.json({
      success: true,
      data: {
        lawyer: {
          id: lawyer._id.toString(),
          name: lawyer.name,
          image: lawyer.image,
          specialization: lawyer.specialization,
          bio: lawyer.bio,
          hourlyRate: lawyer.hourlyRate || 0,
          phone: lawyer.phone,
          barLicenseNumber: lawyer.barLicenseNumber,
          experience: lawyer.experience || 0,
          education: lawyer.education || [],
          languages: lawyer.languages || [],
          city: lawyer.city || lawyer.location || "",
          location: lawyer.location || lawyer.city || "",
          achievements: lawyer.achievements || [],
          isAvailable: lawyer.isAvailable !== false,
          status: lawyer.isAvailable === false ? "busy" : "available",
          dateJoined: lawyer.createdAt,
          rating: reviewStats[0]?.avgRating
            ? Number(reviewStats[0].avgRating.toFixed(1))
            : 0,
          reviews: reviewStats[0]?.totalReviews || 0,
          totalHires,
        },
        comments: enrichedComments,
      },
    });
  } catch (err) {
    console.error("Error fetching lawyer details:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch lawyer details" });
  }
});

// ─── API: Check if lawyer is hired (for detail page) ────────────────
// GET /api/lawyers/:id/hired-status
app.get("/api/lawyers/:id/hired-status", verifyUser, async (req, res) => {
  try {
    const hiring = await db.collection("hiring").findOne({
      userId: req.user._id.toString(),
      lawyerId: req.params.id,
      status: { $in: ["accepted", "paid"] },
    });
    const shortlisted = await db.collection("shortlist").findOne({
      userId: req.user._id.toString(),
      lawyerId: req.params.id,
    });
    return res.json({
      success: true,
      data: {
        isHired: !!hiring,
        isShortlisted: !!shortlisted,
      },
    });
  } catch (err) {
    return res.json({ success: true, data: { isHired: false, isShortlisted: false } });
  }
});

// ─── Start Server ────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 LegalEase backend running on port ${port}`);
});

module.exports = app;
