import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "..", "audio_cache");

// Ensure audio cache directory exists
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// We serve audio files via a static route on our Express server
// BASE_URL/audio/<filename>.mp3 must be publicly accessible by Twilio

/**
 * Convert text to speech using OpenAI TTS
 * Returns a publicly accessible URL for Twilio to play
 */
export async function speak(text, callSid, label = "audio") {
  const filename = `${callSid}_${label}_${Date.now()}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);
  const publicUrl = `${process.env.BASE_URL}/audio/${filename}`;

  try {
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",          // tts-1 = faster + cheaper; tts-1-hd = better quality
      voice: "nova",            // nova = friendly female; options: alloy, echo, fable, onyx, nova, shimmer
      input: text,
      speed: 1.0,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    fs.writeFileSync(filepath, buffer);

    // Schedule cleanup after 5 minutes (Twilio will have fetched it by then)
    setTimeout(() => {
      try {
        fs.unlinkSync(filepath);
      } catch (_) {}
    }, 5 * 60 * 1000);

    console.log(`🔊 TTS generated: ${filename}`);
    return publicUrl;
  } catch (err) {
    console.error("TTS error:", err);
    // Fallback to Twilio's built-in TTS (less natural but always works)
    return null;
  }
}

// Export the audio directory path so server.js can serve it statically
export { AUDIO_DIR };
