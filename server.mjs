import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const execFileAsync = promisify(execFile);

async function loadDotEnv() {
  try {
    const source = await readFile(join(root, ".env"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // A .env file is optional; environment variables work too.
  }
}

await loadDotEnv();

const port = Number(process.env.PORT || 4173);
const ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const model = process.env.LOCAL_RECIPE_MODEL || "gemma3:12b";
const ytDlpPath = process.env.YT_DLP_PATH || join(root, "tools", "yt-dlp_macos");
const ffmpegPath = process.env.FFMPEG_PATH || join(root, "tools", "ffmpeg");
const maxBodyBytes = 24 * 1024 * 1024;
const minimumDetailedNotesLength = 120;
const maxTranscriptCharacters = 24000;
const maxDownloadedVideoBytes = 90 * 1024 * 1024;
const sampledFrameCount = 10;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const recipeSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "summary",
    "sourceCreator",
    "confidence",
    "confidenceNote",
    "timeMinutes",
    "servings",
    "difficulty",
    "tags",
    "evidenceSummary",
    "assumptions",
    "ingredients",
    "steps",
    "substitutions",
    "chefTips",
  ],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    sourceCreator: { type: "string" },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    confidenceNote: { type: "string" },
    timeMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    servings: { type: "integer", minimum: 1, maximum: 24 },
    difficulty: { type: "string", enum: ["Easy", "Medium", "Advanced"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 6 },
    evidenceSummary: { type: "string" },
    assumptions: { type: "array", items: { type: "string" }, maxItems: 8 },
    ingredients: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "amount", "note", "group", "basis", "amountBasis"],
        properties: {
          item: { type: "string" },
          amount: { type: "string" },
          note: { type: "string" },
          group: { type: "string" },
          basis: { type: "string", enum: ["Seen or stated", "Estimated essential"] },
          amountBasis: { type: "string", enum: ["Stated", "Estimated"] },
        },
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "instruction", "duration", "tip"],
        properties: {
          title: { type: "string" },
          instruction: { type: "string" },
          duration: { type: "string" },
          tip: { type: "string" },
        },
      },
    },
    substitutions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original", "swap"],
        properties: {
          original: { type: "string" },
          swap: { type: "string" },
        },
      },
    },
    chefTips: { type: "array", items: { type: "string" }, maxItems: 6 },
  },
};

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "dishIdentified",
    "dishName",
    "visibleIngredients",
    "visibleTechniques",
    "textClues",
    "uncertainDetails",
    "confidence",
    "confidenceReason",
  ],
  properties: {
    dishIdentified: { type: "boolean" },
    dishName: { type: "string" },
    visibleIngredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "statedAmount", "evidence", "certainty"],
        properties: {
          item: { type: "string" },
          statedAmount: { type: "string" },
          evidence: { type: "string" },
          certainty: { type: "string", enum: ["Certain", "Likely", "Unclear"] },
        },
      },
    },
    visibleTechniques: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "evidence", "certainty"],
        properties: {
          action: { type: "string" },
          evidence: { type: "string" },
          certainty: { type: "string", enum: ["Certain", "Likely", "Unclear"] },
        },
      },
    },
    textClues: { type: "array", items: { type: "string" }, maxItems: 12 },
    uncertainDetails: { type: "array", items: { type: "string" }, maxItems: 12 },
    confidence: { type: "string", enum: ["High", "Medium", "Low"] },
    confidenceReason: { type: "string" },
  },
};

const demoRecipe = {
  title: "Crispy Hot Honey Chicken Tenders",
  summary:
    "Golden, extra-craggy chicken tenders with a glossy hot honey finish and a cool herby ranch dip. This is a practical recreation of the short-form recipe.",
  sourceCreator: "@weeknightcravings",
  confidence: "High",
  confidenceNote:
    "The coating, frying method, and hot honey finish are clearly visible. The exact spice quantities are estimated for a balanced home-kitchen version.",
  timeMinutes: 35,
  servings: 4,
  difficulty: "Easy",
  tags: ["Crispy", "Weeknight", "Chicken", "Crowd-pleaser"],
  evidenceSummary:
    "The clip shows breaded chicken tenders being fried until golden and finished with a honey-based glaze. The ingredient quantities are practical home-kitchen estimates.",
  assumptions: [
    "The exact spice blend is estimated because the clip does not display measurements.",
    "The hot honey ratio is adjusted for a balanced four-serving batch.",
  ],
  ingredients: [
    { item: "Chicken tenders", amount: "1 1/2 lb", note: "patted dry", group: "Chicken", basis: "Seen or stated", amountBasis: "Estimated" },
    { item: "Buttermilk", amount: "1 cup", note: "", group: "Chicken", basis: "Estimated essential", amountBasis: "Estimated" },
    { item: "Hot sauce", amount: "2 tbsp", note: "", group: "Chicken", basis: "Estimated essential", amountBasis: "Estimated" },
    { item: "All-purpose flour", amount: "1 1/2 cups", note: "", group: "Crispy coating", basis: "Seen or stated", amountBasis: "Estimated" },
    { item: "Cornstarch", amount: "1/2 cup", note: "for extra crunch", group: "Crispy coating", basis: "Estimated essential", amountBasis: "Estimated" },
    { item: "Smoked paprika", amount: "1 tsp", note: "", group: "Crispy coating", basis: "Estimated essential", amountBasis: "Estimated" },
    { item: "Garlic powder", amount: "1 tsp", note: "", group: "Crispy coating", basis: "Estimated essential", amountBasis: "Estimated" },
    { item: "Kosher salt", amount: "1 1/2 tsp", note: "plus more to finish", group: "Crispy coating", basis: "Estimated essential", amountBasis: "Estimated" },
    { item: "Neutral oil", amount: "4 cups", note: "for frying", group: "Crispy coating", basis: "Seen or stated", amountBasis: "Estimated" },
    { item: "Honey", amount: "1/3 cup", note: "", group: "Hot honey", basis: "Seen or stated", amountBasis: "Estimated" },
    { item: "Hot sauce", amount: "1 tbsp", note: "", group: "Hot honey", basis: "Estimated essential", amountBasis: "Estimated" },
    { item: "Red pepper flakes", amount: "1/2 tsp", note: "adjust to taste", group: "Hot honey", basis: "Estimated essential", amountBasis: "Estimated" },
  ],
  steps: [
    {
      title: "Marinate the chicken",
      instruction:
        "Combine the buttermilk and hot sauce in a bowl. Add the chicken tenders, turn to coat, and let them rest while you prep the coating.",
      duration: "10 min",
      tip: "Even a short buttermilk soak helps the coating cling and keeps the chicken tender.",
    },
    {
      title: "Build the craggy coating",
      instruction:
        "Whisk flour, cornstarch, paprika, garlic powder, and salt in a shallow bowl. Drizzle in 2 tablespoons of the buttermilk mixture and toss with a fork to create small clumps.",
      duration: "4 min",
      tip: "Those little clumps become the crunchy ridges you see in the video.",
    },
    {
      title: "Dredge each tender",
      instruction:
        "Lift one tender from the marinade, let the excess drip off, then press it firmly into the flour mixture. Turn and press again so every side is heavily coated.",
      duration: "5 min",
      tip: "Press instead of lightly tossing: a substantial coating gives you the best crunch.",
    },
    {
      title: "Fry until deeply golden",
      instruction:
        "Heat 1 1/2 inches of oil to 350°F. Fry the tenders in batches for 4 to 6 minutes, turning once, until crisp and cooked through to 165°F. Drain on a wire rack.",
      duration: "12 min",
      tip: "Let the oil return to temperature between batches to avoid a greasy coating.",
    },
    {
      title: "Gloss with hot honey",
      instruction:
        "Warm the honey, hot sauce, and red pepper flakes in a small pan for 1 minute. Drizzle over the hot tenders just before serving.",
      duration: "2 min",
      tip: "Drizzle at the last moment so the crust stays crisp.",
    },
  ],
  substitutions: [
    { original: "Buttermilk", swap: "Use 1 cup milk mixed with 1 tablespoon lemon juice; rest for 5 minutes." },
    { original: "Chicken tenders", swap: "Slice boneless chicken breasts into 1-inch strips." },
  ],
  chefTips: [
    "Use a wire rack instead of paper towels so steam cannot soften the underside.",
    "For less heat, skip the pepper flakes and reduce the hot sauce in the honey by half.",
    "The same coating works in an air fryer: spray generously with oil and cook at 390°F until crisp and cooked through.",
  ],
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("Your sampled frames are too large. Try a shorter or lower-resolution clip.");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateVideoUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Paste a complete Instagram Reel or YouTube URL.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const allowedHosts = ["youtube.com", "youtu.be", "instagram.com"];
  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new Error("This build currently supports Instagram Reels and YouTube links.");
  }
  return url;
}

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'");
}

function getMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPublicMetadata(url) {
  if (!url) return { platform: "Uploaded clip", title: "", description: "", creator: "" };
  const host = url.hostname.toLowerCase();
  const platform = host.includes("instagram") ? "Instagram Reel" : "YouTube";

  if (platform === "YouTube") {
    try {
      const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`;
      const response = await fetchWithTimeout(endpoint);
      if (response.ok) {
        const data = await response.json();
        return {
          platform,
          title: data.title || "",
          description: "",
          creator: data.author_name || "",
        };
      }
    } catch {
      // Fall through to page metadata.
    }
  }

  try {
    const response = await fetchWithTimeout(url.href, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReelToRecipe/1.0)" },
    });
    if (!response.ok) throw new Error("metadata unavailable");
    const html = await response.text();
    return {
      platform,
      title: getMeta(html, "og:title"),
      description: getMeta(html, "og:description") || getMeta(html, "description"),
      creator: "",
    };
  } catch {
    return { platform, title: "", description: "", creator: "" };
  }
}

function emptyTranscript(reason = "No automatic transcript found.") {
  return { found: false, text: "", source: "", language: "", reason };
}

function chooseCaptionTrack(videoInfo) {
  const sources = [
    { tracks: videoInfo.subtitles || {}, source: "creator captions" },
    { tracks: videoInfo.automatic_captions || {}, source: "auto captions" },
  ];
  for (const { tracks, source } of sources) {
    const languages = Object.keys(tracks);
    const preferredLanguages = [
      ...languages.filter((language) => language === "en"),
      ...languages.filter((language) => language.startsWith("en-")),
      ...languages.filter((language) => language !== "en" && !language.startsWith("en-")),
    ];
    for (const language of preferredLanguages) {
      const track = tracks[language]?.find((candidate) => candidate.ext === "json3");
      if (track?.url) return { ...track, language, source };
    }
  }
  return null;
}

function cleanCaptionTranscript(payload) {
  return (payload.events || [])
    .flatMap((event) => event.segs || [])
    .map((segment) => segment.utf8 || "")
    .join(" ")
    .replace(/\[(?:music|applause|laughter|foreign|instrumental)[^\]]*\]/gi, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxTranscriptCharacters);
}

async function fetchYoutubeContext(url) {
  if (!existsSync(ytDlpPath)) {
    return { metadata: null, transcript: emptyTranscript("The bundled YouTube caption helper is missing.") };
  }
  try {
    const { stdout } = await execFileAsync(
      ytDlpPath,
      ["--dump-single-json", "--skip-download", "--no-warnings", "--extractor-args", "youtube:skip=translated_subs", url.href],
      { timeout: 35000, maxBuffer: 12 * 1024 * 1024 },
    );
    const videoInfo = JSON.parse(stdout);
    const metadata = {
      platform: "YouTube",
      title: videoInfo.title || "",
      description: videoInfo.description || "",
      creator: videoInfo.uploader || videoInfo.channel || "",
    };
    const track = chooseCaptionTrack(videoInfo);
    if (!track) {
      return { metadata, transcript: emptyTranscript("This YouTube video does not expose a caption track.") };
    }
    const response = await fetchWithTimeout(track.url, { headers: { "User-Agent": "Mozilla/5.0" } }, 12000);
    if (!response.ok) {
      return { metadata, transcript: emptyTranscript("YouTube did not return the selected caption track.") };
    }
    const text = cleanCaptionTranscript(await response.json());
    if (!text) {
      return { metadata, transcript: emptyTranscript("The selected caption track was empty.") };
    }
    return {
      metadata,
      transcript: {
        found: true,
        text,
        source: track.source,
        language: track.language,
        reason: "",
      },
    };
  } catch {
    return { metadata: null, transcript: emptyTranscript("Automatic YouTube caption retrieval was unavailable for this video.") };
  }
}

async function fetchVideoContext(url) {
  if (!url) {
    return { metadata: await fetchPublicMetadata(url), transcript: emptyTranscript("No video link was supplied.") };
  }
  if (url.hostname.toLowerCase().includes("youtube") || url.hostname.toLowerCase().includes("youtu.be")) {
    const youtubeContext = await fetchYoutubeContext(url);
    if (youtubeContext.metadata) return youtubeContext;
    return { metadata: await fetchPublicMetadata(url), transcript: youtubeContext.transcript };
  }
  const metadata = await fetchPublicMetadata(url);
  const caption = metadata.description?.trim() || "";
  return {
    metadata,
    transcript: caption
      ? { found: true, text: caption.slice(0, maxTranscriptCharacters), source: "Instagram caption", language: "", reason: "" }
      : emptyTranscript("Instagram did not expose a public caption for this Reel."),
  };
}

function emptyVisual(reason = "No automatic visual analysis was available.") {
  return {
    found: false,
    frames: [],
    source: "",
    durationSeconds: 0,
    reason,
  };
}

function explainPlatformVisualFailure(error) {
  const details = `${error.stderr || ""}\n${error.message || ""}`.toLowerCase();
  if (details.includes("max-filesize") || details.includes("file is larger")) {
    return "This platform video is too large for automatic local analysis.";
  }
  if (
    details.includes("private video") ||
    details.includes("login required") ||
    details.includes("sign in") ||
    details.includes("cookies")
  ) {
    return "The platform requires sign-in before it will provide this video's visual stream.";
  }
  if (details.includes("unsupported url")) {
    return "The platform did not expose a downloadable visual stream for this link.";
  }
  return "The platform blocked automatic access to this video's visual stream.";
}

async function readVideoDuration(videoPath) {
  try {
    await execFileAsync(ffmpegPath, ["-hide_banner", "-i", videoPath], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const match = String(error.stderr || "").match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (!match) return 0;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return 0;
}

async function sampleDownloadedVideo(videoPath, tempDir, reportedDuration) {
  const framesDir = join(tempDir, "frames");
  await mkdir(framesDir);
  const durationSeconds = Number(reportedDuration) || (await readVideoDuration(videoPath)) || 30;
  const framesPattern = join(framesDir, "frame-%02d.jpg");
  await execFileAsync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      `fps=${sampledFrameCount}/${durationSeconds},scale='min(640,iw)':-2`,
      "-frames:v",
      String(sampledFrameCount),
      "-q:v",
      "5",
      "-y",
      framesPattern,
    ],
    { timeout: 90000, maxBuffer: 2 * 1024 * 1024 },
  );
  const filenames = (await readdir(framesDir))
    .filter((filename) => filename.endsWith(".jpg"))
    .sort()
    .slice(0, sampledFrameCount);
  if (!filenames.length) {
    throw new Error("The downloaded video did not contain readable visual frames.");
  }
  return {
    durationSeconds,
    frames: await Promise.all(
      filenames.map(async (filename) => `data:image/jpeg;base64,${(await readFile(join(framesDir, filename))).toString("base64")}`),
    ),
  };
}

async function downloadAndSamplePlatformVideo(url) {
  if (!existsSync(ytDlpPath)) {
    return emptyVisual("The bundled platform video downloader is missing.");
  }
  if (!existsSync(ffmpegPath)) {
    return emptyVisual("The bundled local frame extractor is missing.");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "whisk-platform-video-"));
  try {
    const outputTemplate = join(tempDir, "source.%(ext)s");
    const { stdout } = await execFileAsync(
      ytDlpPath,
      [
        "--ignore-config",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--max-filesize",
        "90M",
        "--format",
        "bv*[height<=480]/b[height<=480]/wv*",
        "--output",
        outputTemplate,
        "--print",
        "before_dl:%(duration)s",
        "--print",
        "after_move:%(filepath)s",
        url.href,
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    const outputLines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const reportedDuration = outputLines.map(Number).find((value) => Number.isFinite(value) && value > 0) || 0;
    const downloadedFiles = (await readdir(tempDir)).filter((filename) => filename.startsWith("source.") && !filename.endsWith(".part"));
    const fallbackVideoPath = downloadedFiles[0] ? join(tempDir, downloadedFiles[0]) : "";
    const videoPath = outputLines.find((line) => line.startsWith(tempDir) && existsSync(line)) || fallbackVideoPath;
    if (!videoPath || !existsSync(videoPath)) {
      throw new Error("The platform did not return a downloadable video file.");
    }
    if ((await stat(videoPath)).size > maxDownloadedVideoBytes) {
      throw new Error("The downloaded file is larger than the local analysis limit.");
    }
    const sampled = await sampleDownloadedVideo(videoPath, tempDir, reportedDuration);
    return {
      found: true,
      frames: sampled.frames,
      source: "downloaded platform video",
      durationSeconds: sampled.durationSeconds,
      reason: "",
    };
  } catch (error) {
    return emptyVisual(explainPlatformVisualFailure(error));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function mergeEvidenceText(userNotes, transcript) {
  return [
    userNotes ? `User-provided notes:\n${userNotes}` : "",
    transcript.found ? `Automatically fetched ${transcript.source}${transcript.language ? ` (${transcript.language})` : ""}:\n${transcript.text}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function ollamaModelIsInstalled(models = []) {
  return models.some((installedModel) => {
    const name = installedModel.name || installedModel.model || "";
    return name === model || name === `${model}:latest` || (model.endsWith(":latest") && name === model.slice(0, -7));
  });
}

async function getLocalAiStatus() {
  const videoDownloadHelperReady = existsSync(ytDlpPath);
  const frameExtractorReady = existsSync(ffmpegPath);
  try {
    const response = await fetchWithTimeout(`${ollamaUrl}/api/tags`, {}, 1200);
    if (!response.ok) throw new Error("Ollama is not ready.");
    const payload = await response.json();
    const modelInstalled = ollamaModelIsInstalled(payload.models);
    return {
      ready: modelInstalled,
      provider: "ollama",
      model,
      ollamaRunning: true,
      modelInstalled,
      setupCommand: modelInstalled ? "" : `ollama pull ${model}`,
      transcriptHelperReady: videoDownloadHelperReady,
      videoDownloadHelperReady,
      frameExtractorReady,
      visualAnalysisReady: videoDownloadHelperReady && frameExtractorReady,
    };
  } catch {
    return {
      ready: false,
      provider: "ollama",
      model,
      ollamaRunning: false,
      modelInstalled: false,
      setupCommand: `ollama pull ${model}`,
      transcriptHelperReady: videoDownloadHelperReady,
      videoDownloadHelperReady,
      frameExtractorReady,
      visualAnalysisReady: videoDownloadHelperReady && frameExtractorReady,
    };
  }
}

function buildPrompt({ url, notes, metadata, frameCount }) {
  return [
    "Build a realistic, cookable recipe from the grounded evidence report below.",
    "The evidence report is the source of truth. Metadata is only a clue. Do not invent a dish, ingredient, garnish, sauce, or technique merely because it would be typical.",
    'For ingredients directly supported by the evidence, use basis "Seen or stated". Use "Estimated essential" only for small amounts of ordinary essentials needed to make the supported dish cookable.',
    'Use amountBasis "Stated" only when the evidence report contains a statedAmount. Otherwise use "Estimated".',
    'Put the complete quantity and unit in amount, such as "2 slices" or "1 tsp". Use note only for preparation details such as "ripe", "chopped", or "optional".',
    'For an optional garnish without a stated amount, use "to taste" rather than inventing a quantity.',
    "Use practical home-kitchen quantities, but identify all inferred details in assumptions and confidenceNote.",
    "Keep the steps concrete and chronological. Include food-safe temperatures when relevant.",
    "Do not add side dishes, serving pairings, alternative appliances, substitutions, or chef tips merely because they are conventional. Leave optional arrays empty when the evidence does not support useful additions.",
    "Confidence must be honest: use High only when the notes state quantities and steps clearly; otherwise use Medium or Low.",
    "",
    `Source URL: ${url || "Uploaded clip only"}`,
    `Platform: ${metadata.platform}`,
    `Public title: ${metadata.title || "Unavailable"}`,
    `Public description: ${metadata.description || "Unavailable"}`,
    `Creator: ${metadata.creator || "Unavailable"}`,
    `Sampled frames reviewed: ${frameCount}`,
    `User notes or transcript: ${notes || "None provided"}`,
  ].join("\n");
}

function buildEvidencePrompt({ url, notes, metadata, frameCount }) {
  return [
    "Analyze the supplied short-form cooking-video evidence conservatively. You are an evidence analyst, not a recipe writer.",
    "Review the sampled frames in sequence and list only ingredients and techniques that are visible, stated in the notes, or clearly supported by public metadata.",
    "Treat metadata as a clue, never as proof. Do not fill gaps with a plausible recipe. Do not infer exact measurements from appearance alone.",
    "For each ingredient, put an exact quantity and unit in statedAmount only when it is explicitly written in the notes or caption. Otherwise use an empty string.",
    "Record explicit transcript details such as temperatures, durations, quantities, and serving suggestions in textClues so the recipe writer can distinguish them from visual estimates.",
    'Examples: "two slices of sourdough bread" means statedAmount "2 slices"; "one ripe avocado" means statedAmount "1". Keep preparation descriptors in evidence, not statedAmount.',
    "If this is not clearly a food video, or the dish cannot be identified from the evidence, set dishIdentified to false.",
    "",
    `Source URL: ${url || "Uploaded clip only"}`,
    `Platform: ${metadata.platform}`,
    `Public title: ${metadata.title || "Unavailable"}`,
    `Public description: ${metadata.description || "Unavailable"}`,
    `Creator: ${metadata.creator || "Unavailable"}`,
    `Sampled frames reviewed: ${frameCount}`,
    `User notes or transcript: ${notes || "None provided"}`,
  ].join("\n");
}

async function chatWithOllama({ format, messages }) {
  const response = await fetchWithTimeout(
    `${ollamaUrl}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format,
        options: { temperature: 0, num_ctx: 8192 },
        messages,
      }),
    },
    180000,
  );

  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error || "The local AI recipe analysis failed.";
    throw new Error(message);
  }

  if (!payload.message?.content) {
    throw new Error("The local AI returned an empty response. Please try again.");
  }
  return JSON.parse(payload.message.content);
}

async function extractEvidenceWithOllama({ url, notes, frames, metadata }) {
  return chatWithOllama({
    format: evidenceSchema,
    messages: [
      {
        role: "system",
        content:
          "You extract evidence from cooking videos conservatively. Never invent ingredients, quantities, or techniques. Return only the requested JSON evidence report.",
      },
      {
        role: "user",
        content: buildEvidencePrompt({ url, notes, metadata, frameCount: frames.length }),
        images: frames.map((frame) => frame.replace(/^data:image\/jpeg;base64,/, "")),
      },
    ],
  });
}

async function buildRecipeWithOllama({ url, notes, metadata, frames, evidence }) {
  return chatWithOllama({
    format: recipeSchema,
    messages: [
      {
        role: "system",
        content:
          "You are a careful recipe developer. Build a usable recipe from the supplied evidence report without hiding uncertainty. Return only the requested JSON recipe.",
      },
      {
        role: "user",
        content: [
          buildPrompt({ url, notes, metadata, frameCount: frames.length }),
          "",
          `Grounded evidence report: ${JSON.stringify(evidence)}`,
        ].join("\n"),
      },
    ],
  });
}

function hasDetailedNotes(notes) {
  return notes.replace(/\s+/g, " ").trim().length >= minimumDetailedNotesLength;
}

function normalizeIngredientName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findEvidenceIngredient(item, evidence) {
  const normalizedItem = normalizeIngredientName(item);
  return evidence.visibleIngredients.find((ingredient) => {
    const normalizedEvidenceItem = normalizeIngredientName(ingredient.item);
    return normalizedItem === normalizedEvidenceItem || normalizedItem.includes(normalizedEvidenceItem) || normalizedEvidenceItem.includes(normalizedItem);
  });
}

function isOptionalInNotes(item, notes) {
  const normalizedItem = normalizeIngredientName(item);
  const normalizedNotes = normalizeIngredientName(notes);
  return normalizedNotes.includes(`optional ${normalizedItem}`) || normalizedNotes.includes(`${normalizedItem} optional`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findStatedAmountInNotes(item, notes) {
  const quantity = "(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|one(?:\\s+(?:quarter|half))?|two|three|four|five|six|seven|eight|nine|ten)";
  const unit = "(?:tsp|teaspoons?|tbsp|tablespoons?|cups?|oz|ounces?|lb|pounds?|g|grams?|kg|ml|l|slices?|cloves?|pinch|dash)";
  const descriptor = "(?:(?:ripe|large|small|medium|fresh)\\s+)?";
  const pattern = new RegExp(`\\b(${quantity}(?:\\s+${unit})?)\\s+(?:of\\s+)?${descriptor}${escapeRegExp(normalizeIngredientName(item))}\\b`, "i");
  return normalizeIngredientName(notes).match(pattern)?.[1] || "";
}

function normalizeStatedAmount(value) {
  return value.replace(/\s+(?:ripe|large|small|medium|fresh)$/i, "");
}

function noteIsGrounded(note, groundedIngredient) {
  if (!note) return true;
  const normalizedNote = normalizeIngredientName(note);
  const normalizedItem = normalizeIngredientName(groundedIngredient.item);
  const normalizedEvidence = normalizeIngredientName(groundedIngredient.evidence);
  return (
    normalizedNote === "optional" ||
    normalizedEvidence.includes(`${normalizedNote} ${normalizedItem}`) ||
    normalizedEvidence.includes(`${normalizedItem} ${normalizedNote}`)
  );
}

function normalizeRecipeIngredients(recipe, evidence, notes) {
  const unitOnly = /^(?:tsp|teaspoons?|tbsp|tablespoons?|cups?|oz|ounces?|lb|pounds?|g|grams?|kg|ml|l|slices?|cloves?|pinch|dash)$/i;
  recipe.ingredients = recipe.ingredients.map((ingredient) => {
    const groundedIngredient = findEvidenceIngredient(ingredient.item, evidence);
    if (unitOnly.test(ingredient.note)) {
      ingredient.amount = `${ingredient.amount} ${ingredient.note}`;
      ingredient.note = "";
    }
    if (groundedIngredient) {
      ingredient.basis = "Seen or stated";
      const groundedAmount = normalizeStatedAmount(groundedIngredient.statedAmount) || findStatedAmountInNotes(ingredient.item, notes);
      if (groundedAmount) {
        ingredient.amount = groundedAmount;
        ingredient.amountBasis = "Stated";
      } else {
        ingredient.amountBasis = "Estimated";
        if (/optional/i.test(groundedIngredient.evidence) || /optional/i.test(ingredient.note) || isOptionalInNotes(ingredient.item, notes)) {
          ingredient.amount = "to taste";
          ingredient.note = ingredient.note || "optional";
        }
      }
      if (!noteIsGrounded(ingredient.note, groundedIngredient)) {
        ingredient.note = "";
      }
    } else {
      ingredient.basis = "Estimated essential";
      ingredient.amountBasis = "Estimated";
    }
    return ingredient;
  });
  return recipe;
}

function capRecipeConfidence(recipe, { frames, notes, evidence }) {
  if (recipe.confidence === "High" && !hasDetailedNotes(notes)) {
    recipe.confidence = "Medium";
    recipe.confidenceNote = `${recipe.confidenceNote} Whisk capped this at Medium because the video did not include a detailed written transcript or caption with quantities.`;
  }
  if (evidence.confidence === "Low") {
    recipe.confidence = "Low";
  }
  return recipe;
}

async function handleAnalyze(request, response) {
  try {
    const body = await readJson(request);
    if (body.demo) {
      return sendJson(response, 200, {
        recipe: demoRecipe,
        analysis: { mode: "demo", platform: "Instagram Reel", usedFrames: 6 },
      });
    }

    const parsedUrl = validateVideoUrl(body.url);
    const userNotes = String(body.notes || "").trim().slice(0, 12000);
    const attachedFrames = Array.isArray(body.frames)
      ? body.frames.filter((frame) => typeof frame === "string" && frame.startsWith("data:image/jpeg;base64,")).slice(0, 10)
      : [];
    if (!parsedUrl && !attachedFrames.length) {
      throw new Error("Paste a video link or attach a saved clip to analyze.");
    }
    const aiStatus = await getLocalAiStatus();
    if (!aiStatus.ready) {
      const error = aiStatus.ollamaRunning
        ? `The free local AI is almost ready. Run "${aiStatus.setupCommand}" once, then try again.`
        : "Install and open Ollama, then download the free local recipe model.";
      return sendJson(response, 503, {
        error,
        code: "local_ai_setup",
        setupCommand: aiStatus.setupCommand,
      });
    }
    const { metadata, transcript } = await fetchVideoContext(parsedUrl);
    const platformVisual = parsedUrl
      ? await downloadAndSamplePlatformVideo(parsedUrl)
      : emptyVisual("No platform URL was supplied.");
    const frames = platformVisual.found ? platformVisual.frames : attachedFrames;
    const visual = platformVisual.found
      ? {
          found: true,
          source: platformVisual.source,
          sampledFrames: frames.length,
          durationSeconds: platformVisual.durationSeconds,
          fallbackUsed: false,
          reason: "",
        }
      : attachedFrames.length
        ? {
            found: true,
            source: "attached saved clip",
            sampledFrames: attachedFrames.length,
            durationSeconds: 0,
            fallbackUsed: true,
            reason: platformVisual.reason,
          }
        : {
            found: false,
            source: "",
            sampledFrames: 0,
            durationSeconds: 0,
            fallbackUsed: false,
            reason: platformVisual.reason,
          };
    const notes = mergeEvidenceText(userNotes, transcript);
    if (!frames.length) {
      return sendJson(response, 422, {
        error: `${visual.reason} Attach a saved clip so Whisk can inspect the actual video frames before making a recipe.`,
        code: "needs_evidence",
        transcript: { ...transcript, text: "" },
        visual,
      });
    }
    const evidence = await extractEvidenceWithOllama({
      url: parsedUrl?.href || "",
      notes,
      frames,
      metadata,
    });
    if (!evidence.dishIdentified || !evidence.visibleIngredients.length) {
      return sendJson(response, 422, {
        error:
          "Whisk reviewed this video's visual frames but could not identify enough cooking evidence to write a trustworthy recipe. Try a clearer food video.",
        code: "needs_evidence",
        transcript: { ...transcript, text: "" },
        visual,
      });
    }
    const recipe = capRecipeConfidence(
      normalizeRecipeIngredients(await buildRecipeWithOllama({
        url: parsedUrl?.href || "",
        notes,
        frames,
        metadata,
        evidence,
      }), evidence, notes),
      { frames, notes, evidence },
    );
    return sendJson(response, 200, {
      recipe,
      analysis: {
        mode: "local-ai",
        model,
        platform: metadata.platform,
        usedFrames: frames.length,
        metadataFound: Boolean(metadata.title || metadata.description),
        evidenceConfidence: evidence.confidence,
        evidence,
        visual,
        transcript: {
          found: transcript.found,
          source: transcript.source,
          language: transcript.language,
          characters: transcript.text.length,
          reason: transcript.reason,
        },
      },
    });
  } catch (error) {
    return sendJson(response, 400, { error: error.message || "Could not analyze that video." });
  }
}

async function serveStatic(request, response) {
  const path = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const normalizedPath = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalizedPath);
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  try {
    const data = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/status") {
    return sendJson(response, 200, await getLocalAiStatus());
  }
  if (request.method === "POST" && request.url === "/api/analyze") {
    return handleAnalyze(request, response);
  }
  if (request.method === "GET") {
    return serveStatic(request, response);
  }
  response.writeHead(405);
  response.end("Method not allowed");
});

server.listen(port, () => {
  console.log(`Reel to Recipe is ready at http://localhost:${port}`);
  console.log(`Free local AI mode uses Ollama with ${model}.`);
});
