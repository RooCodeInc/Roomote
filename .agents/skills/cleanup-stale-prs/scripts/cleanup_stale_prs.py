#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
import json
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any


@dataclass(frozen=True)
class Candidate:
    number: int
    title: str
    updated_at: datetime
    updated_at_raw: str
    url: str
    change_type: str
    topic: str


@dataclass(frozen=True)
class SelectionResult:
    cutoff: datetime
    candidates: list[Candidate]
    stale_before_exemptions: int
    exempted_count: int


@dataclass(frozen=True)
class TopicRule:
    label: str
    keywords: tuple[tuple[str, int], ...]

TOPIC_RULES = (
    TopicRule(
        label="Experimental / placeholder work",
        keywords=(
            ("poc", 6),
            ("prototype", 6),
            ("hello world", 6),
            ("foo.txt", 6),
            ("todo", 4),
            ("basic landing page", 5),
        ),
    ),
    TopicRule(
        label="Marketing site & positioning",
        keywords=(
            ("marketing", 6),
            ("homepage", 5),
            ("landing page", 5),
            ("hero", 4),
            ("headline", 4),
            ("subtitle", 3),
            ("copy", 3),
            ("color palette", 3),
            ("funny", 3),
            ("funnier", 3),
        ),
    ),
    TopicRule(
        label="Documentation & docs hygiene",
        keywords=(
            ("docs", 6),
            ("documentation", 4),
            ("readme", 4),
            ("architecture", 4),
            ("doc ", 2),
            (".md", 3),
        ),
    ),
    TopicRule(
        label="Slack workflows & messaging",
        keywords=(
            ("slack", 7),
            ("thread", 4),
            ("channel", 3),
            ("mention", 3),
            ("sender profile", 4),
            ("checkmark reaction", 4),
            ("explainer", 4),
        ),
    ),
    TopicRule(
        label="GitHub / PR automation",
        keywords=(
            ("github", 5),
            ("pull request", 5),
            ("pr review", 7),
            ("pr creation", 6),
            ("preview comment", 4),
            ("reviewer", 4),
            ("mergeability", 4),
            ("webhook", 3),
            ("line range", 4),
            ("conflict", 3),
        ),
    ),
    TopicRule(
        label="External integrations & MCP",
        keywords=(
            ("mcp", 7),
            ("figma", 5),
            ("snowflake", 5),
            ("vercel", 5),
            ("granola", 5),
            ("gmail", 5),
            ("linear", 4),
            ("oauth", 3),
            ("linked accounts", 3),
            ("integrations page", 3),
            ("catalog", 3),
        ),
    ),
    TopicRule(
        label="Preview, sandbox & snapshots",
        keywords=(
            ("preview", 7),
            ("sandbox", 7),
            ("snapshot", 6),
            ("wake-up", 5),
            ("wake up", 5),
            ("resume", 4),
            ("iframe", 4),
            ("x-forwarded-host", 4),
            ("primary port", 4),
            ("xpra", 5),
        ),
    ),
    TopicRule(
        label="Worker, runtime & infrastructure",
        keywords=(
            ("worker", 7),
            ("cloud job", 6),
            ("cloud agent", 6),
            ("auth-proxy", 5),
            ("redis", 5),
            ("bullmq", 5),
            ("queue", 3),
            ("runtime", 4),
            ("opencode", 5),
            ("harness", 4),
            ("roomote cli", 4),
            ("shell", 2),
        ),
    ),
    TopicRule(
        label="Task UI, chat & user settings",
        keywords=(
            ("task", 5),
            ("tasks page", 5),
            ("chat", 5),
            ("message", 4),
            ("messages", 4),
            ("onboarding", 4),
            ("settings", 4),
            ("avatars", 4),
            ("presence", 4),
            ("typing indicators", 4),
            ("bookmark", 4),
            ("unread", 4),
            ("image attachment", 4),
            ("members settings", 4),
            ("user settings", 4),
        ),
    ),
    TopicRule(
        label="Developer tooling & environment setup",
        keywords=(
            ("environment config", 5),
            ("tool versions", 5),
            ("setup commands", 5),
            ("pnpm format", 4),
            ("lint script", 4),
            ("seed script", 4),
            ("ui testing", 4),
            ("modern cli tools", 4),
            ("auth bypass", 4),
            ("migration", 3),
        ),
    ),
    TopicRule(
        label="Testing & verification",
        keywords=(
            ("vitest", 6),
            ("browser automation", 6),
            ("test", 4),
            ("validation", 4),
            ("verify", 4),
            ("verification", 4),
            ("diagnostic logging", 2),
        ),
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="List and optionally close stale GitHub pull requests.",
    )
    parser.add_argument(
        "--repo",
        help="GitHub repository in owner/repo form. Defaults to the current gh repo.",
    )
    parser.add_argument(
        "--stale-days",
        type=int,
        default=7,
        help="PRs older than this many days are considered stale. Default: 7.",
    )
    parser.add_argument(
        "--exempt-label",
        default="wip",
        help="Skip PRs that have this label, case-insensitive. Default: wip.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=500,
        help="Maximum number of open PRs to inspect. Default: 500.",
    )
    parser.add_argument(
        "--comment",
        help="Override the close comment used with --apply.",
    )

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Close matching PRs after listing them.",
    )
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="List matching PRs without closing them. This is also the default mode.",
    )

    args = parser.parse_args()

    if args.stale_days < 1:
        parser.error("--stale-days must be at least 1")
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    if not args.exempt_label.strip():
        parser.error("--exempt-label must not be empty")

    return args


def run_gh(*args: str) -> str:
    try:
        result = subprocess.run(
            ["gh", *args],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("`gh` was not found on PATH.") from exc

    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(
            message or f"`gh {' '.join(args)}` failed with exit code {result.returncode}."
        )

    return result.stdout


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def get_repo_name(explicit_repo: str | None) -> str:
    if explicit_repo:
        return explicit_repo

    return run_gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").strip()


def load_open_prs(repo: str, limit: int) -> list[dict[str, Any]]:
    raw = run_gh(
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        str(limit),
        "--json",
        "number,title,body,updatedAt,labels,url",
    )
    data = json.loads(raw)
    if not isinstance(data, list):
        raise RuntimeError("Unexpected response from `gh pr list`.")
    return data


def find_candidates(
    pull_requests: list[dict[str, Any]],
    stale_days: int,
    exempt_label: str,
) -> SelectionResult:
    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_days)
    exempt_label_lc = exempt_label.casefold()
    candidates: list[Candidate] = []
    stale_before_exemptions = 0
    exempted_count = 0

    for pull_request in pull_requests:
        updated_at_raw = str(pull_request["updatedAt"])
        updated_at = parse_timestamp(updated_at_raw)
        if updated_at >= cutoff:
            continue
        stale_before_exemptions += 1

        labels = [
            str(label.get("name", "")).casefold()
            for label in pull_request.get("labels", [])
            if isinstance(label, dict)
        ]
        if exempt_label_lc in labels:
            exempted_count += 1
            continue

        title = str(pull_request["title"])
        body = str(pull_request.get("body", ""))
        candidates.append(
            Candidate(
                number=int(pull_request["number"]),
                title=title,
                updated_at=updated_at,
                updated_at_raw=updated_at_raw,
                url=str(pull_request["url"]),
                change_type=classify_change_type(title),
                topic=classify_topic(title, body),
            )
        )

    candidates.sort(key=lambda candidate: candidate.updated_at)
    return SelectionResult(
        cutoff=cutoff,
        candidates=candidates,
        stale_before_exemptions=stale_before_exemptions,
        exempted_count=exempted_count,
    )


def format_utc(value: datetime) -> str:
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean_body_for_classification(body: str) -> str:
    cleaned_lines: list[str] = []
    in_code_block = False
    in_preview_block = False
    in_validation_section = False

    for raw_line in body.splitlines():
        line = raw_line.strip()
        if line.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue

        if line == "<!-- roomote-preview-start -->":
            in_preview_block = True
            continue
        if line == "<!-- roomote-preview-end -->":
            in_preview_block = False
            continue
        if in_preview_block:
            continue

        if line.startswith("## "):
            heading = line[3:].strip().casefold()
            in_validation_section = heading == "validation"
            continue
        if in_validation_section:
            continue
        if line:
            cleaned_lines.append(line)

    return "\n".join(cleaned_lines)


def classify_change_type(title: str) -> str:
    title_lc = title.casefold()
    prefix_match = re.match(r"^\s*([a-z]+)(?:\([^)]+\))?[:\s-]", title_lc)
    prefix = prefix_match.group(1) if prefix_match else ""

    change_type = {
        "feat": "Features",
        "fix": "Fixes",
        "docs": "Documentation",
        "chore": "Chores",
        "refactor": "Refactors",
        "test": "Tests",
        "perf": "Performance",
        "poc": "Prototypes",
    }.get(prefix)
    if change_type:
        return change_type

    if "prototype" in title_lc:
        return "Prototypes"
    if "readme" in title_lc or "docs" in title_lc or "documentation" in title_lc:
        return "Documentation"
    if "test" in title_lc or "verify" in title_lc or "validation" in title_lc:
        return "Tests"
    if "fix" in title_lc or "bug" in title_lc:
        return "Fixes"
    if "add " in title_lc or "introduce" in title_lc or "implement" in title_lc:
        return "Features"
    return "Other"


def score_keywords(title_lc: str, body_lc: str, keywords: tuple[tuple[str, int], ...]) -> int:
    score = 0
    for phrase, weight in keywords:
        if phrase in title_lc:
            score += weight * 3
        if phrase in body_lc:
            score += weight
    return score


def classify_topic(title: str, body: str) -> str:
    title_lc = title.casefold()
    body_lc = clean_body_for_classification(body).casefold()
    scores: list[tuple[int, int, str]] = []

    for index, rule in enumerate(TOPIC_RULES):
        score = score_keywords(title_lc, body_lc, rule.keywords)
        if score > 0:
            scores.append((score, -index, rule.label))

    if scores:
        return max(scores)[2]

    change_type = classify_change_type(title)
    if change_type == "Documentation":
        return "Documentation & docs hygiene"
    if change_type == "Tests":
        return "Testing & verification"
    if change_type == "Prototypes":
        return "Experimental / placeholder work"
    return "Unclassified"


def format_change_breakdown(candidates: list[Candidate]) -> str:
    counts = Counter(candidate.change_type for candidate in candidates)
    ordered = sorted(
        counts.items(),
        key=lambda item: (-item[1], item[0]),
    )
    return ", ".join(f"{count} {label.lower()}" for label, count in ordered)


def group_candidates_by_topic(candidates: list[Candidate]) -> list[tuple[str, list[Candidate]]]:
    grouped: dict[str, list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate.topic].append(candidate)

    return sorted(
        grouped.items(),
        key=lambda item: (-len(item[1]), item[1][0].updated_at, item[0]),
    )


def print_grouped_summary(candidates: list[Candidate]) -> None:
    if not candidates:
        return

    print("Candidate groups:")
    for topic, grouped_candidates in group_candidates_by_topic(candidates):
        oldest = format_utc(grouped_candidates[0].updated_at)
        newest = format_utc(grouped_candidates[-1].updated_at)
        breakdown = format_change_breakdown(grouped_candidates)
        print(
            f"- {topic}: {len(grouped_candidates)} "
            f"({breakdown}; oldest {oldest}; newest {newest})"
        )


def print_grouped_candidate_details(candidates: list[Candidate]) -> None:
    if not candidates:
        return

    print("Detailed candidates by group:")
    for topic, grouped_candidates in group_candidates_by_topic(candidates):
        print(f"{topic} ({len(grouped_candidates)}):")
        for candidate in grouped_candidates:
            print(
                f"  - #{candidate.number} | {candidate.change_type} | "
                f"{candidate.updated_at_raw} | {candidate.title} | {candidate.url}"
            )


def close_candidates(
    repo: str,
    candidates: list[Candidate],
    comment: str,
) -> None:
    for candidate in candidates:
        run_gh(
            "pr",
            "close",
            str(candidate.number),
            "--repo",
            repo,
            "--comment",
            comment,
        )
        print(f"Closed #{candidate.number}")


def main() -> int:
    args = parse_args()
    apply_mode = args.apply

    try:
        repo = get_repo_name(args.repo)
        pull_requests = load_open_prs(repo, args.limit)
        result = find_candidates(
            pull_requests,
            stale_days=args.stale_days,
            exempt_label=args.exempt_label,
        )
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"Error: failed to parse PR data: {exc}", file=sys.stderr)
        return 1

    print(f"Repo: {repo}")
    print(f"Mode: {'apply' if apply_mode else 'dry-run'}")
    print(f"Stale threshold (days): {args.stale_days}")
    print(f"Cutoff (UTC): {format_utc(result.cutoff)}")
    print(f"Exempt label: {args.exempt_label}")
    print(f"Open PRs inspected: {len(pull_requests)}")
    print(f"Stale before exemptions: {result.stale_before_exemptions}")
    print(f"Exempted by label: {result.exempted_count}")
    print(f"Candidates: {len(result.candidates)}")

    if not result.candidates:
        print("No stale PRs matched the current criteria.")
        return 0

    print_grouped_summary(result.candidates)

    if not apply_mode:
        print_grouped_candidate_details(result.candidates)
        print("Dry run only. Re-run with --apply to close these PRs.")
        return 0

    for candidate in result.candidates:
        print(
            f"- #{candidate.number} | {candidate.updated_at_raw} | "
            f"{candidate.title} | {candidate.url}"
        )

    comment = args.comment or (
        f"Closing as stale: no updates for {args.stale_days} day(s) "
        f"and no '{args.exempt_label}' label."
    )

    try:
        close_candidates(repo, result.candidates, comment)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
