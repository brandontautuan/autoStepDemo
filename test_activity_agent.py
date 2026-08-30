import unittest
from datetime import datetime, timezone

from activity_agent import ActivityAgent, ActivityApiError, AgentBudget


class FakeActivityAgent(ActivityAgent):
    def __init__(self):
        super().__init__(base_url="http://test")
        self.calls = []

    def _get_json(self, path):
        self.calls.append(path)
        if path == "/api/summary":
            return {"totalTrackedMs": 3000, "activityCount": 2, "switchCount": 1, "apps": [{"appName": "Code", "totalDurationMs": 2000, "sessions": 1}]}
        if path == "/api/activity":
            return [
                {"timestamp": "2026-08-29T12:00:00Z", "appName": "Code", "durationMs": 2000},
                {"timestamp": "2026-08-29T12:01:00Z", "appName": "Safari", "durationMs": 1000},
            ]
        return {"capturedAt": "2026-08-29T12:02:00Z", "currentWindow": {"appName": "Safari"}}


class ActivityAgentTests(unittest.TestCase):
    def test_analysis_calls_summary_before_activity_and_current(self):
        agent = FakeActivityAgent()
        result = agent.analyze("Code", recent_minutes=120, now=datetime(2026, 8, 29, 12, 2, tzinfo=timezone.utc))
        self.assertEqual(agent.calls, ["/api/summary", "/api/activity", "/api/current"])
        self.assertTrue(result["appVerification"]["verified"])
        self.assertEqual(result["flow"], ["Code", "Safari"])

    def test_recent_activity_filters_by_time(self):
        agent = FakeActivityAgent()
        records = agent.get_recent_activity(minutes=1, now=datetime(2026, 8, 29, 12, 1, 30, tzinfo=timezone.utc))
        self.assertEqual([record["appName"] for record in records], ["Safari"])


class AgentBudgetTests(unittest.TestCase):
    def test_limits_requests_and_duplicate_tools(self):
        budget = AgentBudget(max_requests=2, max_tool_calls=2, max_calls_per_tool=1)
        budget.allow_request()
        budget.allow_request()
        with self.assertRaises(ActivityApiError):
            budget.allow_request()

        budget.allow_tool("get_activity_summary")
        with self.assertRaises(ActivityApiError):
            budget.allow_tool("get_activity_summary")
        budget.allow_tool("get_current_window")
        with self.assertRaises(ActivityApiError):
            budget.allow_tool("get_recent_activity")


if __name__ == "__main__":
    unittest.main()
