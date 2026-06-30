import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { c, cpp, java, python, node as runNode } from "compile-run";

dotenv.config();

// Safety net: log unexpected errors instead of letting the whole process die.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 5000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
// EXECUTOR: "compile-run" (local, no Docker/VPS needed, just needs compilers
// installed on the host) or "piston" (self-hosted Piston instance via PISTON_URL)
const EXECUTOR = process.env.EXECUTOR || "compile-run";
// Only used when EXECUTOR=piston. Point at your own self-hosted Piston, e.g.
// http://YOUR_VPS_IP:2000/api/v2/execute
const PISTON_URL = process.env.PISTON_URL || "http://localhost:2000/api/v2/execute";

// compile-run only supports a handful of languages out of the box (c, cpp, java,
// python, node). Add more languages here only if the host machine has the
// matching compiler/interpreter installed AND you extend the runners map below.
const COMPILE_RUN_RUNNERS = {
  python: python,
  javascript: runNode,
  c: c,
  cpp: cpp,
  java: java,
};

// Map of friendly language names -> Piston runtime + version + default filename
// Piston supports 60+ languages; these are the most commonly requested ones.
const LANGUAGE_MAP = {
  python: { language: "python", version: "3.10.0", file: "main.py" },
  javascript: { language: "javascript", version: "18.15.0", file: "main.js" },
  typescript: { language: "typescript", version: "5.0.3", file: "main.ts" },
  java: { language: "java", version: "15.0.2", file: "Main.java" },
  c: { language: "c", version: "10.2.0", file: "main.c" },
  cpp: { language: "c++", version: "10.2.0", file: "main.cpp" },
  go: { language: "go", version: "1.16.2", file: "main.go" },
  rust: { language: "rust", version: "1.68.2", file: "main.rs" },
  ruby: { language: "ruby", version: "3.0.1", file: "main.rb" },
  php: { language: "php", version: "8.2.3", file: "main.php" },
  bash: { language: "bash", version: "5.2.0", file: "main.sh" },
  kotlin: { language: "kotlin", version: "1.8.20", file: "main.kt" },
  swift: { language: "swift", version: "5.3.3", file: "main.swift" },
  lua: { language: "lua", version: "5.4.4", file: "main.lua" },
};

app.get("/api/languages", (req, res) => {
  if (EXECUTOR === "compile-run") {
    return res.json(Object.keys(COMPILE_RUN_RUNNERS));
  }
  res.json(Object.keys(LANGUAGE_MAP));
});

// ---- RUN CODE ----
app.post("/api/run", async (req, res) => {
  const { language, code, stdin } = req.body;

  if (EXECUTOR === "compile-run") {
    const runner = COMPILE_RUN_RUNNERS[language];
    if (!runner) {
      return res.status(400).json({
        error: `Unsupported language in compile-run mode: ${language}. Supported: ${Object.keys(
          COMPILE_RUN_RUNNERS
        ).join(", ")}`,
      });
    }
    try {
      const result = await runner.runSource(code, { stdin: stdin || "" });
      res.json({
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exitCode ?? null,
        raw: result,
      });
    } catch (err) {
      console.error("compile-run error:", err && err.message ? err.message : err);
      res.status(500).json({
        error:
          "Execution failed. Make sure the matching compiler/interpreter (python, gcc, g++, java/javac, node) is installed and on your PATH. On Windows, compile-run often needs 'python' instead of 'python3' — consider switching EXECUTOR=piston instead, which avoids this entirely.",
      });
    }
    return;
  }

  // ---- EXECUTOR === "piston" (self-hosted) ----
  const conf = LANGUAGE_MAP[language];
  if (!conf) {
    return res.status(400).json({ error: `Unsupported language: ${language}` });
  }

  try {
    const response = await axios.post(PISTON_URL, {
      language: conf.language,
      version: conf.version,
      files: [{ name: conf.file, content: code }],
      stdin: stdin || "",
    });

    const result = response.data;
    const stdout = result.run?.stdout || "";
    const stderr = result.run?.stderr || result.compile?.stderr || "";
    const exitCode = result.run?.code ?? null;

    res.json({ stdout, stderr, exitCode, raw: result });
  } catch (err) {
    console.error("Run error:", err.message);
    res.status(500).json({
      error:
        "Execution service failed. Is your self-hosted Piston instance running and reachable at PISTON_URL?",
    });
  }
});

// ---- AI DEBUG / FIX (Gemini) ----
// mode: "bro" -> casual bro-slang explanation
//       "normal" -> clean professional explanation
//       "fix" -> returns corrected code
app.post("/api/ai", async (req, res) => {
  const { language, code, stderr, stdout, mode } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(500).json({
      error: "GROQ_API_KEY not configured on server. Add it to backend/.env",
    });
  }

  let systemPrompt;
  if (mode === "bro") {
    systemPrompt = `You are "Bro Mode" - a hype, friendly coding buddy who talks like a chill bro
(use words like "bro", "fam", "ngl", "fr fr", light emoji use is fine). Despite the slang,
your debugging advice must be 100% technically accurate and genuinely helpful. Keep it
concise: 1) call out the exact error in bro-speak, 2) explain WHY it happened, 3) tell them
EXACTLY what to change, with a short code snippet if useful. Don't ramble.`;
  } else if (mode === "fix") {
    systemPrompt = `You are a precise code-fixing engine. Given buggy code and its error output,
return ONLY the fully corrected code for the given language, with no explanation, no markdown
fences, no commentary - just the raw fixed source code, ready to run.`;
  } else {
    systemPrompt = `You are a clear, professional coding assistant. Explain the error concisely,
why it happened, and exactly how to fix it. Include a short corrected snippet if helpful.`;
  }

  const userPrompt = `Language: ${language}

CODE:
\`\`\`${language}
${code}
\`\`\`

STDOUT:
${stdout || "(empty)"}

STDERR / ERROR:
${stderr || "(no error captured, but user wants a review)"}
`;

  try {
    const groqRes = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: mode === "fix" ? 0.2 : 0.7,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
      }
    );

    const text =
      groqRes.data?.choices?.[0]?.message?.content ||
      "Hmm, no response came back. Try again, bro.";

    let cleaned = text.trim();
    if (mode === "fix") {
      // Strip markdown code fences (```lang ... ``` or ``` ... ```) the model
      // sometimes adds despite being told not to - editor should get raw code only.
      cleaned = cleaned
        .replace(/^```[a-zA-Z0-9+#.-]*\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
    }

    res.json({ result: cleaned });
  } catch (err) {
    console.error("Groq error:", err.response?.data || err.message);
    res.status(500).json({ error: "AI service failed. Check your Groq API key/quota." });
  }
});

app.get("/", (req, res) => {
  res.send("Compile on the Go backend is running 🚀");
});

app.listen(PORT, () => {
  console.log(`Compile on the Go backend running on http://localhost:${PORT}`);
});
