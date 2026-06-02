# Whisk: Reel to Recipe

A dependency-free web app that turns Instagram Reels and YouTube food videos into kitchen-ready recipes with a free local AI.

## Free local AI setup

Whisk uses [Ollama](https://ollama.com/download) and the open local `gemma3:12b` vision model. There is no API key, subscription, or per-recipe charge.

1. [Download Ollama for macOS](https://ollama.com/download/mac), move it to Applications, and open it.

2. Download the local vision model once:

```bash
ollama pull gemma3:12b
```

3. Start Whisk:

```bash
cd outputs/reel-to-recipe
node server.mjs
```

Then open [http://localhost:4173](http://localhost:4173).

The UI also has a built-in sample recipe, so the full interaction can be previewed before local AI setup is complete.

## How analysis works

- Paste an Instagram Reel or YouTube URL.
- Whisk downloads the public platform video into a temporary folder, samples ten frames locally, and deletes the temporary media after analysis.
- For YouTube links, Whisk also retrieves creator captions or auto-generated captions when the video exposes them.
- Attach a saved video clip only when a platform blocks automatic download. The browser samples ten fallback frames for the same local vision model.
- Optionally add notes for details that captions may miss, such as ingredients shown only on screen.
- The server fetches public URL metadata where available, extracts a conservative evidence report, then asks the model running on your computer for a grounded structured recipe.

## Privacy and platform limitation

The AI analysis stays on your computer. Fetching a public title, caption track, or video stream for a pasted link still contacts YouTube or Instagram. Temporary downloaded media is deleted after its frames are sampled.

Instagram and YouTube can prevent automated tools from fetching actual video bytes from some URLs. When that happens, attach a saved clip so the local model still has visual evidence. Whisk refuses requests without visual frames instead of using captions as a shortcut and generating a polished guess.

Whisk bundles [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and a macOS [`FFmpeg`](https://ffmpeg.org/download.html) build for free platform-video download and local frame extraction. Attribution details are in [`tools/README.md`](tools/README.md).
