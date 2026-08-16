import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB Connection Successful!");
    process.exit(0);
  } catch (err) {
    console.error("❌ MongoDB Connection Failed:", err.message);
    process.exit(1);
  }
}
test();
