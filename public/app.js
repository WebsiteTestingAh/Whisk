const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const hero = $("#hero");
const form = $("#recipe-form");
const analyzingView = $("#analyzing-view");
const recipeView = $("#recipe-view");
const savedView = $("#saved-view");
const urlInput = $("#video-url");
const notesToggle = $("#notes-toggle");
const notesWrap = $("#notes-wrap");
const notesInput = $("#notes");
const clipInput = $("#clip-input");
const clipLabel = $("#clip-label");
const analyzeButton = $("#analyze-button");
const modal = $("#error-modal");
const toast = $("#toast");
let currentRecipe = null;
let currentAnalysis = null;
let attachedClip = null;
let toastTimeout;
let aiStatus = null;
const savedRecipesKey = "whisk-saved-recipes";
const legacySavedRecipeKey = "whisk-saved-recipe";

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 2300);
}

function escapeHtml(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

async function checkStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    aiStatus = data;
    const apiStatus = $("#api-status");
    apiStatus.classList.toggle("is-ready", data.ready);
    apiStatus.querySelector("span:last-child").textContent = data.ready ? "Local AI ready" : "Free AI setup";
    $("#setup-ai-button").hidden = data.ready;
  } catch {
    $("#api-status span:last-child").textContent = "Server offline";
  }
}

notesToggle.addEventListener("click", () => {
  notesWrap.hidden = !notesWrap.hidden;
  if (!notesWrap.hidden) notesInput.focus();
});

clipInput.addEventListener("change", () => {
  attachedClip = clipInput.files[0] || null;
  clipLabel.textContent = attachedClip ? `${attachedClip.name} attached` : "Attach clip only if the platform blocks access";
  if (attachedClip) showToast("Clip attached. Whisk will review ten frames.");
});

function waitFor(target, eventName) {
  return new Promise((resolve, reject) => {
    target.addEventListener(eventName, resolve, { once: true });
    target.addEventListener("error", () => reject(new Error("Could not read that video clip.")), { once: true });
  });
}

async function sampleFrames(file) {
  if (!file) return [];
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;

  try {
    await waitFor(video, "loadedmetadata");
    const duration = Math.max(video.duration || 1, 1);
    const points = [0.03, 0.12, 0.22, 0.33, 0.44, 0.56, 0.67, 0.78, 0.88, 0.97].map((point) =>
      Math.max(0, Math.min(duration * point, duration - 0.05)),
    );
    const canvas = document.createElement("canvas");
    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    const frames = [];

    for (const point of points) {
      video.currentTime = point;
      await waitFor(video, "seeked");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.76));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openModal(message, title = "One quick setup step", setupCommand = "") {
  $("#modal-title").textContent = title;
  $("#modal-message").textContent = message;
  $("#modal-command").textContent = setupCommand;
  $("#modal-command").hidden = !setupCommand;
  $("#modal-copy-command").hidden = !setupCommand;
  $("#ollama-download").hidden = title !== "Set up your free local AI";
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
}

$("#modal-close").addEventListener("click", closeModal);
$("#modal-dismiss").addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

function setView(view) {
  hero.hidden = view !== "hero";
  analyzingView.hidden = view !== "analyzing";
  recipeView.hidden = view !== "recipe";
  savedView.hidden = view !== "saved";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function animateProgress() {
  const messages = [
    "Downloading the public video for local visual review.",
    "Inspecting ten sampled frames and checking captions.",
    "Building kitchen-friendly quantities from the evidence.",
    "Auditing the recipe for unsupported guesses.",
  ];
  const fills = ["18%", "43%", "72%", "91%"];
  for (let index = 0; index < messages.length; index += 1) {
    $("#analysis-message").textContent = messages[index];
    $("#progress-fill").style.width = fills[index];
    await new Promise((resolve) => setTimeout(resolve, 820));
  }
}

async function requestRecipe({ demo = false } = {}) {
  setView("analyzing");
  analyzeButton.disabled = true;
  $("#progress-fill").style.width = "9%";
  const progress = animateProgress();

  try {
    const frames = demo ? [] : await sampleFrames(attachedClip);
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        demo,
        url: urlInput.value.trim(),
        notes: notesInput.value.trim(),
        frames,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "Could not make that recipe.");
      error.code = data.code;
      error.setupCommand = data.setupCommand;
      throw error;
    }
    await progress;
    currentRecipe = data.recipe;
    currentAnalysis = data.analysis;
    renderRecipe(data.recipe, data.analysis);
    setView("recipe");
  } catch (error) {
    setView("hero");
    const title =
      error.code === "local_ai_setup"
        ? "Set up your free local AI"
        : error.code === "needs_evidence"
          ? "Whisk needs to see more"
          : "That recipe needs another look";
    openModal(error.message, title, error.setupCommand);
  } finally {
    analyzeButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  requestRecipe();
});

$("#modal-copy-command").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#modal-command").textContent);
  showToast("Setup command copied.");
});

$("#setup-ai-button").addEventListener("click", () => {
  const message = aiStatus?.ollamaRunning
    ? "Ollama is open. Download the free local recipe model once, then Whisk is ready."
    : "Install and open Ollama, then download the free local recipe model once. Whisk will run entirely on this computer.";
  openModal(message, "Set up your free local AI", aiStatus?.setupCommand || "ollama pull gemma3:12b");
});

$$(".example-chip").forEach((button) => {
  button.addEventListener("click", () => requestRecipe({ demo: true }));
});

$("#modal-demo").addEventListener("click", () => {
  closeModal();
  requestRecipe({ demo: true });
});

$("#back-button").addEventListener("click", () => setView("hero"));

function groupIngredients(ingredients) {
  return ingredients.reduce((groups, ingredient) => {
    const name = ingredient.group || "Ingredients";
    groups[name] ||= [];
    groups[name].push(ingredient);
    return groups;
  }, {});
}

function recipeId(recipe) {
  return [
    recipe.title,
    recipe.sourceCreator || "",
    recipe.ingredients.map((ingredient) => `${ingredient.amount}:${ingredient.item}`).join("|"),
  ]
    .join("::")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function migrateLegacySavedRecipe() {
  const legacyRecipe = localStorage.getItem(legacySavedRecipeKey);
  if (!legacyRecipe || localStorage.getItem(savedRecipesKey)) return;
  try {
    const recipe = JSON.parse(legacyRecipe);
    localStorage.setItem(
      savedRecipesKey,
      JSON.stringify([{ id: recipeId(recipe), recipe, analysis: null, savedAt: new Date().toISOString() }]),
    );
  } catch {
    // Ignore malformed legacy data.
  }
  localStorage.removeItem(legacySavedRecipeKey);
}

function getSavedRecipes() {
  migrateLegacySavedRecipe();
  try {
    const saved = JSON.parse(localStorage.getItem(savedRecipesKey) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function setSavedRecipes(savedRecipes) {
  localStorage.setItem(savedRecipesKey, JSON.stringify(savedRecipes));
  updateSavedBadge();
}

function currentRecipeIsSaved() {
  if (!currentRecipe) return false;
  return getSavedRecipes().some((saved) => saved.id === recipeId(currentRecipe));
}

function updateSavedBadge() {
  const count = getSavedRecipes().length;
  $("#saved-badge").hidden = !count;
  $("#saved-badge").textContent = count > 9 ? "9+" : String(count);
}

function updateSaveButton() {
  const isSaved = currentRecipeIsSaved();
  $("#save-button").classList.toggle("is-saved", isSaved);
  $("#save-button").innerHTML = isSaved
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8v16l-6-3.5-6 3.5z" /></svg>Saved'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8v16l-6-3.5-6 3.5z" /></svg>Save';
}

function renderRecipe(recipe, analysis = null) {
  $("#recipe-title").textContent = recipe.title;
  $("#recipe-summary").textContent = recipe.summary;
  $("#recipe-time").textContent = `${recipe.timeMinutes} min`;
  $("#recipe-servings").textContent = `${recipe.servings} ${recipe.servings === 1 ? "person" : "people"}`;
  $("#recipe-difficulty").textContent = recipe.difficulty;
  $("#recipe-confidence").textContent = recipe.confidence;
  $("#confidence-note").textContent = recipe.confidenceNote;
  $("#evidence-summary").textContent =
    recipe.evidenceSummary || "This saved recipe predates Whisk's grounding report. Analyze the clip again for an evidence audit.";
  const visualReport = $("#visual-report");
  visualReport.hidden = !analysis?.visual?.found;
  visualReport.textContent = analysis?.visual?.found
    ? `${analysis.visual.fallbackUsed ? "Attached clip fallback" : "Automatic platform video review"} used ${analysis.visual.sampledFrames} sampled frames.`
    : "";
  const transcriptReport = $("#transcript-report");
  transcriptReport.hidden = !analysis?.transcript?.found;
  if (analysis?.transcript?.found) {
    const transcriptSource = analysis.transcript.source === "auto captions" ? "Automatic captions" : analysis.transcript.source;
    transcriptReport.textContent = `${transcriptSource.charAt(0).toUpperCase()}${transcriptSource.slice(1)} used${
      analysis.transcript.language ? ` (${analysis.transcript.language})` : ""
    }.`;
  } else {
    transcriptReport.textContent = "";
  }
  const assumptions = recipe.assumptions || [];
  $("#assumptions-wrap").hidden = !assumptions.length;
  $("#assumption-list").innerHTML = assumptions.map((assumption) => `<li>${escapeHtml(assumption)}</li>`).join("");
  $("#tag-row").innerHTML = recipe.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");

  $("#ingredient-list").innerHTML = Object.entries(groupIngredients(recipe.ingredients))
    .map(
      ([group, ingredients]) => `
        <div class="ingredient-group">
          <h4>${escapeHtml(group)}</h4>
          ${ingredients
            .map(
              (ingredient) => `
                <label class="ingredient-item">
                  <input type="checkbox" />
                  <span><b>${escapeHtml(ingredient.amount)}</b> ${escapeHtml(ingredient.item)}
                    ${ingredient.note ? `<small>${escapeHtml(ingredient.note)}</small>` : ""}
                    ${
                      ingredient.basis === "Estimated essential"
                        ? '<small class="ingredient-estimate">Estimated ingredient & quantity</small>'
                        : ingredient.amountBasis === "Estimated"
                          ? '<small class="ingredient-estimate">Estimated quantity</small>'
                          : ""
                    }
                  </span>
                </label>`,
            )
            .join("")}
        </div>`,
    )
    .join("");

  $$(".ingredient-item input").forEach((checkbox) => {
    checkbox.addEventListener("change", () => checkbox.closest(".ingredient-item").classList.toggle("is-checked", checkbox.checked));
  });

  $("#step-count").textContent = `${recipe.steps.length} steps`;
  $("#steps-list").innerHTML = recipe.steps
    .map(
      (step, index) => `
        <article class="step-card">
          <span class="step-number">${index + 1}</span>
          <div>
            <div class="step-top">
              <h4>${escapeHtml(step.title)}</h4>
              <span class="step-time">${escapeHtml(step.duration)}</span>
            </div>
            <p>${escapeHtml(step.instruction)}</p>
            ${step.tip ? `<span class="step-tip"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6m-5 3h4" /><path d="M8.7 14.5a6 6 0 1 1 6.6 0c-.8.5-1.3 1.4-1.3 2.3h-4c0-.9-.5-1.8-1.3-2.3z" /></svg>${escapeHtml(step.tip)}</span>` : ""}
          </div>
        </article>`,
    )
    .join("");

  $("#substitution-list").innerHTML = recipe.substitutions.length
    ? recipe.substitutions
        .map((swap) => `<div class="swap-row"><strong>${escapeHtml(swap.original)}</strong>${escapeHtml(swap.swap)}</div>`)
        .join("")
    : '<div class="swap-row">No substitutions needed for this one.</div>';

  $("#tips-list").innerHTML = recipe.chefTips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("");
  updateSaveButton();
}

$("#check-all-button").addEventListener("click", () => {
  const checkboxes = $$(".ingredient-item input");
  const shouldCheck = checkboxes.some((checkbox) => !checkbox.checked);
  checkboxes.forEach((checkbox) => {
    checkbox.checked = shouldCheck;
    checkbox.closest(".ingredient-item").classList.toggle("is-checked", shouldCheck);
  });
  $("#check-all-button").textContent = shouldCheck ? "Clear all" : "Check all";
});

function recipeAsText(recipe) {
  return [
    recipe.title,
    recipe.summary,
    "",
    `Time: ${recipe.timeMinutes} min | Servings: ${recipe.servings} | Difficulty: ${recipe.difficulty}`,
    "",
    "INGREDIENTS",
    ...recipe.ingredients.map((ingredient) => `- ${ingredient.amount} ${ingredient.item}${ingredient.note ? ` (${ingredient.note})` : ""}`),
    "",
    "STEPS",
    ...recipe.steps.map((step, index) => `${index + 1}. ${step.title}: ${step.instruction}`),
    "",
    "ESTIMATED DETAILS TO REVIEW",
    ...(recipe.assumptions || []).map((assumption) => `- ${assumption}`),
  ].join("\n");
}

$("#copy-button").addEventListener("click", async () => {
  if (!currentRecipe) return;
  await navigator.clipboard.writeText(recipeAsText(currentRecipe));
  showToast("Recipe copied to your clipboard.");
});

$("#save-button").addEventListener("click", () => {
  if (!currentRecipe) return;
  const id = recipeId(currentRecipe);
  const savedRecipes = getSavedRecipes();
  const existingIndex = savedRecipes.findIndex((saved) => saved.id === id);
  if (existingIndex >= 0) {
    savedRecipes.splice(existingIndex, 1);
    setSavedRecipes(savedRecipes);
    updateSaveButton();
    showToast("Recipe removed from your notebook.");
    return;
  }
  savedRecipes.unshift({ id, recipe: currentRecipe, analysis: currentAnalysis, savedAt: new Date().toISOString() });
  setSavedRecipes(savedRecipes);
  updateSaveButton();
  showToast("Recipe added to your notebook.");
});

function renderSavedRecipes() {
  const savedRecipes = getSavedRecipes();
  $("#saved-count").textContent = `${savedRecipes.length} ${savedRecipes.length === 1 ? "recipe" : "recipes"} saved`;
  $("#saved-empty").hidden = Boolean(savedRecipes.length);
  $("#saved-grid").hidden = !savedRecipes.length;
  $("#saved-grid").innerHTML = savedRecipes
    .map(
      ({ id, recipe }) => `
        <article class="saved-card">
          <div class="saved-card-top">
            <span>${escapeHtml(recipe.confidence)} confidence</span>
            <button class="saved-remove" type="button" data-remove-recipe="${escapeAttribute(id)}" aria-label="Remove ${escapeAttribute(recipe.title)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-3h4l1 3m-9 0 1 14h10l1-14" /></svg>
            </button>
          </div>
          <h3>${escapeHtml(recipe.title)}</h3>
          <p>${escapeHtml(recipe.summary)}</p>
          <div class="saved-card-meta">
            <span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>${escapeHtml(String(recipe.timeMinutes))} min</span>
            <span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 19v-1a4 4 0 0 1 8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /></svg>${escapeHtml(String(recipe.servings))} servings</span>
          </div>
          <button class="secondary-action saved-open" type="button" data-open-recipe="${escapeAttribute(id)}">Open recipe</button>
        </article>`,
    )
    .join("");
}

function openSavedRecipes() {
  renderSavedRecipes();
  setView("saved");
}

function startNewRecipe() {
  setView("hero");
  urlInput.focus();
}

$("#saved-button").addEventListener("click", openSavedRecipes);
$("#saved-back-button").addEventListener("click", () => setView("hero"));
$("#saved-new-button").addEventListener("click", startNewRecipe);
$("#saved-empty-button").addEventListener("click", startNewRecipe);
$("#saved-grid").addEventListener("click", (event) => {
  const openButton = event.target.closest("[data-open-recipe]");
  if (openButton) {
    const saved = getSavedRecipes().find((item) => item.id === openButton.dataset.openRecipe);
    if (!saved) return;
    currentRecipe = saved.recipe;
    currentAnalysis = saved.analysis;
    renderRecipe(currentRecipe, currentAnalysis);
    setView("recipe");
    return;
  }
  const removeButton = event.target.closest("[data-remove-recipe]");
  if (!removeButton) return;
  setSavedRecipes(getSavedRecipes().filter((saved) => saved.id !== removeButton.dataset.removeRecipe));
  renderSavedRecipes();
  showToast("Recipe removed from your notebook.");
});

checkStatus();
updateSavedBadge();
