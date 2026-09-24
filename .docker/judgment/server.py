"""Roomote judgment sidecar: a CPU decision model for self-hosted deployments.

Serves the decision contract Roomote's `roomote` judgment backend calls
(`POST /v1/decisions` with `{state, questions}`, answered with `{answers}`),
backed by a GLiNER 2.5 classifier, so a deployment without a Jev key or a GPU
endpoint can still run the Memory check, reply addressing, and Roomote's other
typed decisions. Point Roomote at it with `R_JUDGMENT_UPSTREAM_URL`.

Each question becomes one GLiNER classification task: the first sentence of
its instructions is the task name, the full instructions are the task's
instruction, and its options are labels with descriptions (yes/no for `noul`,
the criteria for `choice`, `level N` for `score`). Questions over the same
state share one forward pass.

Environment:
  JUDGMENT_MODEL      GLiNER 2.5 checkpoint: a Hugging Face id or a local path
                      (default: roomote/roomote-judgment-gliner, fine-tuned on
                      Roomote's decisions; a general-purpose checkpoint answers
                      them close to chance).
  HF_TOKEN            For a private Hugging Face checkpoint.
  JUDGMENT_API_KEY    Bearer token callers must send; unset for a private
                      network where only Roomote can reach the sidecar.
  JUDGMENT_THREADS    CPU threads for inference (default: all cores).
  JUDGMENT_DEVICE     `cpu` (default) or `cuda` on a host with an NVIDIA GPU.
  JUDGMENT_PRELOAD    `false` loads the model on the first decision instead of at
                      startup, so a sidecar deployed but not yet switched on
                      idles without it (default: `true`).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from gliner2.classification import ClassificationSchema, Classifier

MODEL = os.environ.get("JUDGMENT_MODEL", "").strip() or "roomote/roomote-judgment-gliner"
API_KEY = os.environ.get("JUDGMENT_API_KEY", "").strip()
SERVED_MODEL = "roomote-judgment"

# Mirrors Roomote's MAX_QUESTIONS_PER_REQUEST.
MAX_QUESTIONS = 64
MAX_BODY_BYTES = 4 * 1024 * 1024
# About the 2k-token state budget the model is trained with; longer states are
# cut rather than slowing every request down.
MAX_TEXT_CHARS = 8_000
FIRST_SENTENCE = re.compile(r"(?<=[?.])\s")
# GLiNER splices label and instruction strings into its own prompt; these
# tokens would corrupt its alignment, so they are replaced wherever they appear.
RESERVED = {"[P]": "P", "[L]": "L", "[C]": "C", "[E]": "E", "[R]": "R", "[DESCRIPTION]": "DESCRIPTION",
            "[EXAMPLE]": "EXAMPLE", "[OUTPUT]": "OUTPUT", "(": ", ", ")": ", "}

torch.set_num_threads(int(os.environ.get("JUDGMENT_THREADS") or os.cpu_count() or 1))
# Inference is CPU-bound: requests take turns rather than splitting the cores
# (and the memory) between them. The same lock guards the first load.
inference_lock = threading.Lock()
_classifier: Classifier | None = None
app = FastAPI()


def classifier() -> Classifier:
    global _classifier
    if _classifier is None:
        _classifier = Classifier.from_pretrained(MODEL, map_location=os.environ.get("JUDGMENT_DEVICE") or "cpu")
    return _classifier


if os.environ.get("JUDGMENT_PRELOAD", "true").strip().lower() != "false":
    classifier()


def clean(text: str, limit: int) -> str:
    for token, replacement in RESERVED.items():
        text = text.replace(token, replacement)
    return " ".join(text.split())[:limit].strip(" ,") or "-"


def labels_for(question: dict) -> dict[str, str]:
    criteria = question.get("criteria")
    if question["type"] == "noul":
        criteria = criteria if isinstance(criteria, dict) else {}
        return {"yes": clean(str(criteria.get("true") or "yes, the statement holds"), 300),
                "no": clean(str(criteria.get("false") or "no, the statement does not hold"), 300)}
    if question["type"] == "choice":
        criteria = {c: c for c in criteria} if isinstance(criteria, list) else criteria
        return {clean(str(key), 80): clean(str(value or key), 300) for key, value in criteria.items()}
    return {f"level {i}": clean(str(level), 300) for i, level in enumerate(criteria)}


def validate(questions) -> None:
    if not isinstance(questions, dict) or not questions:
        raise HTTPException(400, "questions must be a non-empty object")
    if len(questions) > MAX_QUESTIONS:
        raise HTTPException(400, f"at most {MAX_QUESTIONS} questions per request")
    for qid, question in questions.items():
        if not isinstance(question, dict) or not isinstance(question.get("instructions"), str):
            raise HTTPException(400, f"question {qid!r} needs instructions")
        kind, criteria = question.get("type"), question.get("criteria")
        if kind == "choice" and not (isinstance(criteria, (dict, list)) and criteria):
            raise HTTPException(400, f"choice question {qid!r} needs criteria")
        if kind == "score" and not (isinstance(criteria, list) and len(criteria) >= 2):
            raise HTTPException(400, f"score question {qid!r} needs at least two levels")
        if kind not in ("noul", "choice", "score"):
            raise HTTPException(400, f"question {qid!r} has unknown type {kind!r}")


def text_of(state) -> str:
    text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
    return text[:MAX_TEXT_CHARS]


def task(question: dict) -> tuple[str, dict[str, str], str]:
    name = clean(FIRST_SENTENCE.split(question["instructions"], maxsplit=1)[0], 300)
    return name, labels_for(question), clean(question["instructions"], 1500)


def answer(question: dict, probabilities: dict[str, float]) -> dict:
    """In the shape Roomote validates (isValidAnswer in typesafe-judgment.ts)."""
    kind = question["type"]
    if kind == "noul":
        yes, no = probabilities.get("yes", 0.0), probabilities.get("no", 0.0)
        return {"type": "noul", "noul": round(yes / ((yes + no) or 1.0), 4)}
    if kind == "choice":
        criteria = question["criteria"]
        keys = [str(key) for key in (criteria if isinstance(criteria, list) else criteria.keys())]
        by_key = {key: probabilities.get(clean(key, 80), 0.0) for key in keys}
        total = sum(by_key.values()) or 1.0
        by_key = {key: value / total for key, value in by_key.items()}
        top = max(by_key, key=by_key.get)
        return {"type": "choice", "choice": top, "confidence": round(by_key[top], 4),
                "probabilities": {key: round(value, 4) for key, value in by_key.items()}}
    levels = [probabilities.get(f"level {i}", 0.0) for i in range(len(question["criteria"]))]
    total = sum(levels) or 1.0
    levels = [value / total for value in levels]
    return {"type": "score", "score": round(sum(i * p for i, p in enumerate(levels)), 4),
            "confidence": round(max(levels), 4)}


def decide(state, questions: dict) -> dict:
    schema, names = ClassificationSchema(), {}
    for qid, question in questions.items():
        name, labels, instruction = task(question)
        while name in names.values():
            name += " ."
        names[qid] = name
        schema = schema.single(name, labels, instruction=instruction)
    with torch.inference_mode():
        result = classifier().classify(text_of(state), schema).to_dict()
    return {qid: answer(question, result[names[qid]]["probabilities"]) for qid, question in questions.items()}


@app.post("/v1/decisions")
async def decisions(request: Request):
    if API_KEY and request.headers.get("authorization") != f"Bearer {API_KEY}":
        raise HTTPException(401, "invalid bearer token")
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(413, "request too large")
    try:
        payload = json.loads(body)
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    if not isinstance(payload, dict) or "state" not in payload:
        raise HTTPException(400, "state is required")
    questions = payload.get("questions")
    validate(questions)

    started = time.perf_counter()
    # Starlette runs a sync function off the event loop; the lock keeps one
    # inference on the CPU at a time.
    def run():
        with inference_lock:
            return decide(payload["state"], questions)

    from starlette.concurrency import run_in_threadpool

    answers = await run_in_threadpool(run)
    # Counts and timing only; never state or question text.
    print(f"decision questions={len(questions)} ms={int((time.perf_counter() - started) * 1000)}", flush=True)
    return JSONResponse({"model": SERVED_MODEL, "answers": answers})


@app.get("/health")
def health():
    return {"status": "ok", "model": SERVED_MODEL}
