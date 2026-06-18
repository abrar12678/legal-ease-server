const express = require("express");
const cors = require("cors");
const app = express();
const port = 5000;
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

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

// ─── Health Check ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("LegalEase Backend is running!");
});

// ─── API: Get My Hirings ─────────────────────────────────────────────
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

// ─── API: Update User Profile ────────────────────────────────────────
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

// ─── Start Server ────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 LegalEase backend running on port ${port}`);
});

module.exports = app;
