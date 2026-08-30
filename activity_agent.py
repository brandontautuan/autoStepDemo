#!/usr/bin/env python3
"""Small local activity agent backed by Window Observer's localhost API."""

import argparse
import json
import os
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _load_env_file():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    try:
        lines = open(env_path, encoding="utf-8").read().splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip("\"'")
        os.environ.setdefault(key.strip(), value)


_load_env_file()


class ActivityApiError(RuntimeError):
    """Raised when the local activity API cannot be read."""


def _env_int(name, default, minimum=0):
    try:
        return max(minimum, int(os.getenv(name, default)))
    except (TypeError, ValueError):
        return default


def _env_float(name, default, minimum=0.0):
    try:
        return max(minimum, float(os.getenv(name, default)))
    except (TypeError, ValueError):
        return default


class AgentBudget:
    """Hard per-ask limits so a model cannot run an unbounded tool loop."""

    def __init__(self, max_requests=3, max_tool_calls=3, max_calls_per_tool=1):
        self.max_requests = max_requests
        self.max_tool_calls = max_tool_calls
        self.max_calls_per_tool = max_calls_per_tool
        self.requests = 0
        self.tool_calls = 0
        self.calls_by_tool = {}

    def allow_request(self):
        if self.requests >= self.max_requests:
            raise ActivityApiError(f"Model request budget exhausted ({self.max_requests} requests per ask)")
        self.requests += 1

    def allow_tool(self, name):
        if self.tool_calls >= self.max_tool_calls:
            raise ActivityApiError(f"Tool-call budget exhausted ({self.max_tool_calls} tool calls per ask)")
        count = self.calls_by_tool.get(name, 0)
        if count >= self.max_calls_per_tool:
            raise ActivityApiError(f"Tool {name!r} may only be called once per ask")
        self.calls_by_tool[name] = count + 1
        self.tool_calls += 1


class ProcessRateLimiter:
    """Best-effort process-wide limiter for repeated agent invocations."""

    _lock = Lock()
    _request_times = deque()

    @classmethod
    def wait_for_slot(cls, max_per_minute, min_interval):
        while True:
            now = time.monotonic()
            with cls._lock:
                while cls._request_times and now - cls._request_times[0] >= 60:
                    cls._request_times.popleft()
                since_last = now - cls._request_times[-1] if cls._request_times else None
                if len(cls._request_times) < max_per_minute and (since_last is None or since_last >= min_interval):
                    cls._request_times.append(now)
                    return
                wait_seconds = max(
                    (60 - (now - cls._request_times[0])) if cls._request_times else 0,
                    (min_interval - since_last) if since_last is not None else 0,
                )
            time.sleep(wait_seconds)


def _parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration_text(duration_ms):
    total_seconds = max(0, int(duration_ms or 0)) // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def _app_flow(records):
    flow = []
    for record in records:
        app_name = record.get("appName") or "Unknown app"
        if not flow or flow[-1] != app_name:
            flow.append(app_name)
    return flow


class ActivityAgent:
    def __init__(self, base_url=None, timeout=5):
        self.base_url = (base_url or os.getenv("WINDOW_OBSERVER_API_URL", "http://127.0.0.1:47821")).rstrip("/")
        self.timeout = timeout

    def _get_json(self, path):
        request = Request(f"{self.base_url}{path}", headers={"Accept": "application/json"})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            try:
                detail = json.loads(error.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                detail = {"error": error.reason}
            raise ActivityApiError(f"GET {path} returned HTTP {error.code}: {detail.get('error', detail)}") from error
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            raise ActivityApiError(f"Could not read {path} from {self.base_url}: {error}") from error

    # Agent tools: these names intentionally mirror the planned tool contract.
    def get_activity_summary(self):
        return self._get_json("/api/summary")

    def get_recent_activity(self, minutes=60, limit=None, now=None):
        records = self._get_json("/api/activity")
        if not isinstance(records, list):
            raise ActivityApiError("/api/activity returned an invalid response")
        current_time = now or datetime.now(timezone.utc)
        cutoff = current_time - timedelta(minutes=max(0, minutes))
        recent = [record for record in records if (_parse_timestamp(record.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff]
        recent.sort(key=lambda record: _parse_timestamp(record.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc))
        return recent[-limit:] if limit else recent

    def get_current_window(self):
        return self._get_json("/api/current")

    def analyze(self, app_name=None, recent_minutes=60, limit=None, now=None):
        """Run the analysis in the intended order: summary, activity, current."""
        summary = self.get_activity_summary()
        apps = summary.get("apps", [])
        match = None
        if app_name:
            match = next((app for app in apps if app.get("appName", "").casefold() == app_name.casefold()), None)
        recent = self.get_recent_activity(minutes=recent_minutes, limit=limit, now=now)
        current = self.get_current_window()
        result = {
            "summary": summary,
            "recentActivity": recent,
            "flow": _app_flow(recent),
            "currentWindow": current.get("currentWindow"),
        }
        if app_name:
            result["appVerification"] = {
                "requestedApp": app_name,
                "verified": match is not None,
                "app": match,
            }
        return result


class GroqActivityAgent:
    """Hosted-LLM wrapper that uses ActivityAgent as its local tool provider."""

    TOOL_DEFINITIONS = [
        {
            "type": "function",
            "name": "get_activity_summary",
            "description": "Get aggregate tracked time and per-application sessions. Call this first.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            "strict": True,
        },
        {
            "type": "function",
            "name": "get_recent_activity",
            "description": "Get completed foreground activity records for a recent time window.",
            "parameters": {
                "type": "object",
                "properties": {
                    "minutes": {"type": "integer", "minimum": 0},
                    "limit": {"type": ["integer", "null"], "minimum": 1},
                },
                "required": ["minutes", "limit"],
                "additionalProperties": False,
            },
            "strict": True,
        },
        {
            "type": "function",
            "name": "get_current_window",
            "description": "Get the most recently captured foreground window.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            "strict": True,
        },
    ]

    def __init__(self, activity_agent=None, model=None):
        try:
            from groq import Groq
        except ImportError as error:
            raise ActivityApiError("Groq support requires `pip install -r requirements.txt`") from error
        self.client = Groq()
        self.activity_agent = activity_agent or ActivityAgent()
        self.model = model or os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
        self.max_requests_per_ask = _env_int("GROQ_MAX_REQUESTS_PER_ASK", 3, 1)
        self.max_tool_calls_per_ask = _env_int("GROQ_MAX_TOOL_CALLS_PER_ASK", 3, 1)
        self.max_calls_per_tool = _env_int("GROQ_MAX_CALLS_PER_TOOL", 1, 1)
        self.max_requests_per_minute = _env_int("GROQ_MAX_REQUESTS_PER_MINUTE", 10, 1)
        self.min_request_interval = _env_float("GROQ_MIN_REQUEST_INTERVAL_SECONDS", 0.5, 0)
        self.max_output_tokens = _env_int("GROQ_MAX_OUTPUT_TOKENS", 800, 1)

    def _run_tool(self, name, arguments):
        if name == "get_activity_summary":
            return self.activity_agent.get_activity_summary()
        if name == "get_recent_activity":
            return self.activity_agent.get_recent_activity(**arguments)
        if name == "get_current_window":
            return self.activity_agent.get_current_window()
        raise ActivityApiError(f"Unknown activity tool: {name}")

    def _create_response(self, budget, **kwargs):
        budget.allow_request()
        ProcessRateLimiter.wait_for_slot(self.max_requests_per_minute, self.min_request_interval)
        kwargs.setdefault("max_tokens", self.max_output_tokens)
        try:
            return self.client.chat.completions.create(**kwargs)
        except Exception as error:
            raise ActivityApiError(f"Groq request failed: {error}") from error

    def ask(self, question):
        instructions = (
            "You are an activity-analysis assistant. Use only the provided local activity tools. "
            "You must call get_activity_summary first. Use its app totals as authoritative for "
            "collective time and app verification. Then call get_recent_activity to explain the "
            "chronological app flow. Call get_current_window when useful. Be concise and distinguish "
            "completed foreground intervals from all open windows."
        )
        budget = AgentBudget(
            max_requests=self.max_requests_per_ask,
            max_tool_calls=self.max_tool_calls_per_ask,
            max_calls_per_tool=self.max_calls_per_tool,
        )
        messages = [{"role": "system", "content": instructions}, {"role": "user", "content": question}]
        groq_tools = [{"type": "function", "function": tool} for tool in self.TOOL_DEFINITIONS]
        response = self._create_response(
            budget,
            model=self.model,
            messages=messages,
            tools=groq_tools,
            tool_choice={"type": "function", "function": {"name": "get_activity_summary"}},
        )
        for _ in range(self.max_requests_per_ask):
            message = response.choices[0].message
            calls = message.tool_calls or []
            if not calls:
                return message.content or ""
            if not budget.calls_by_tool and calls[0].function.name != "get_activity_summary":
                raise ActivityApiError("The model attempted to skip the required summary-first step")
            messages.append({
                "role": "assistant",
                "content": message.content,
                "tool_calls": [{
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.function.name, "arguments": call.function.arguments},
                } for call in calls],
            })
            tool_outputs = []
            for call in calls:
                name = call.function.name
                budget.allow_tool(name)
                arguments = json.loads(call.function.arguments or "{}")
                try:
                    output = self._run_tool(name, arguments)
                except ActivityApiError as error:
                    output = {"error": str(error)}
                tool_outputs.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(output)})
            messages.extend(tool_outputs)
            response = self._create_response(
                budget,
                model=self.model,
                messages=messages,
                tools=groq_tools,
            )
        raise ActivityApiError("Groq tool-calling loop exceeded its safety limit")


def main():
    parser = argparse.ArgumentParser(description="Analyze activity from the local Window Observer API.")
    parser.add_argument("--app", help="Verify this app against the summary, e.g. 'Visual Studio Code'.")
    parser.add_argument("--minutes", type=int, default=60, help="Include activity from the last N minutes (default: 60).")
    parser.add_argument("--limit", type=int, help="Limit the number of recent records returned.")
    parser.add_argument("--ask", help="Ask the hosted Groq agent a question.")
    args = parser.parse_args()
    try:
        if args.ask:
            print(GroqActivityAgent().ask(args.ask))
        else:
            print(json.dumps(ActivityAgent().analyze(args.app, args.minutes, args.limit), indent=2))
    except ActivityApiError as error:
        parser.exit(1, f"activity-agent: {error}\n")


if __name__ == "__main__":
    main()
