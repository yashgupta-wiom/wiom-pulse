require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ===== JIRA HELPERS =====
const jiraHeaders = {
  'Authorization': 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64'),
  'Content-Type': 'application/json',
  'Accept': 'application/json'
};

async function jiraSearch(jql, maxResults = 50, fields = null) {
  const defaultFields = ['summary','status','project','issuetype','priority','assignee','labels','updated','resolutiondate','issuelinks','customfield_10016','created','duedate'];
  const res = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: jiraHeaders,
    body: JSON.stringify({ jql, maxResults, fields: fields || defaultFields })
  });
  const data = await res.json();
  if (data.errorMessages) throw new Error(data.errorMessages.join('; '));
  return data;
}

function mapIssue(i) {
  return {
    key: i.key,
    summary: i.fields?.summary,
    status: i.fields?.status?.name,
    statusCategory: i.fields?.status?.statusCategory?.name,
    project: i.fields?.project?.key,
    projectName: i.fields?.project?.name,
    assignee: i.fields?.assignee?.displayName || 'Unassigned',
    priority: i.fields?.priority?.name,
    type: i.fields?.issuetype?.name,
    labels: i.fields?.labels || [],
    storyPoints: i.fields?.customfield_10016 || null,
    created: i.fields?.created,
    updated: i.fields?.updated,
    resolved: i.fields?.resolutiondate,
    dueDate: i.fields?.duedate,
    links: (i.fields?.issuelinks || []).map(l => ({
      type: l.type?.name,
      direction: l.inwardIssue ? 'inward' : 'outward',
      linkedKey: l.inwardIssue?.key || l.outwardIssue?.key,
      linkedSummary: l.inwardIssue?.fields?.summary || l.outwardIssue?.fields?.summary,
      linkedStatus: l.inwardIssue?.fields?.status?.name || l.outwardIssue?.fields?.status?.name
    }))
  };
}

// ===== JIRA ENDPOINTS =====

// Active sprint issues (via Agile API — still works)
app.get('/api/jira/sprint', async (req, res) => {
  try {
    const boardsRes = await fetch(`${process.env.JIRA_BASE_URL}/rest/agile/1.0/board?maxResults=50`, { headers: jiraHeaders });
    const boards = await boardsRes.json();
    const allSprints = [];
    for (const board of (boards.values || []).slice(0, 15)) {
      try {
        const sprintRes = await fetch(`${process.env.JIRA_BASE_URL}/rest/agile/1.0/board/${board.id}/sprint?state=active&maxResults=5`, { headers: jiraHeaders });
        const sprints = await sprintRes.json();
        for (const sprint of (sprints.values || [])) {
          const issuesRes = await fetch(`${process.env.JIRA_BASE_URL}/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=200&fields=summary,status,assignee,priority,issuetype,labels,customfield_10016`, { headers: jiraHeaders });
          const issues = await issuesRes.json();
          allSprints.push({
            sprint: { id: sprint.id, name: sprint.name, startDate: sprint.startDate, endDate: sprint.endDate, state: sprint.state },
            board: { id: board.id, name: board.name },
            issues: (issues.issues || []).map(mapIssue)
          });
        }
      } catch (e) { /* skip boards without sprints */ }
    }
    res.json({ success: true, data: allSprints });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Shipped / Released / Live items
app.get('/api/jira/shipped', async (req, res) => {
  try {
    const days = req.query.days || 14;
    const data = await jiraSearch(
      `status in (Released, Live, "-Live-", "RELEASED TO PROD", Done, "Issue Resolved.") AND updated >= -${days}d ORDER BY updated DESC`,
      50
    );
    res.json({ success: true, total: data.total || (data.issues || []).length, issues: (data.issues || []).map(mapIssue) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Blockers and high priority items
app.get('/api/jira/blockers', async (req, res) => {
  try {
    const data = await jiraSearch(
      `(status in (Blocked, blocked, "Blocked/More Info Needed") OR priority in (Highest, Critical)) AND statusCategory != Done ORDER BY priority DESC, updated DESC`,
      30
    );
    res.json({ success: true, total: data.total || (data.issues || []).length, issues: (data.issues || []).map(mapIssue) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upcoming / To Do items
app.get('/api/jira/upcoming', async (req, res) => {
  try {
    const data = await jiraSearch(
      `status in ("To Do", ToDo, Backlog, "Ready for QA", "READY FOR DEV", "In Design", "PRD In progress") AND updated >= -30d ORDER BY priority DESC, updated DESC`,
      30
    );
    res.json({ success: true, total: data.total || (data.issues || []).length, issues: (data.issues || []).map(mapIssue) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// In Progress items
app.get('/api/jira/inprogress', async (req, res) => {
  try {
    const data = await jiraSearch(
      `status in ("In Progress", "In dev", "IN DEV", "In Review", "In QA", "IN QA", "Ready for QA", "READY FOR QA", "In UAT") AND updated >= -14d ORDER BY updated DESC`,
      50
    );
    res.json({ success: true, total: data.total || (data.issues || []).length, issues: (data.issues || []).map(mapIssue) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Custom JQL query
app.post('/api/jira/search', async (req, res) => {
  try {
    const { jql, maxResults } = req.body;
    const data = await jiraSearch(jql, maxResults || 50);
    res.json({ success: true, total: data.total || (data.issues || []).length, issues: (data.issues || []).map(mapIssue) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===== METABASE API =====
const mbHeaders = {
  'x-api-key': process.env.METABASE_API_KEY,
  'Content-Type': 'application/json'
};

app.get('/api/metabase/card/:id', async (req, res) => {
  try {
    const response = await fetch(`${process.env.METABASE_BASE_URL}/api/card/${req.params.id}/query/json`, { headers: mbHeaders });
    const data = await response.json();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/metabase/dashboards', async (req, res) => {
  try {
    const response = await fetch(`${process.env.METABASE_BASE_URL}/api/dashboard`, { headers: mbHeaders });
    const data = await response.json();
    res.json({ success: true, data: (data || []).map(d => ({ id: d.id, name: d.name, description: d.description })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/metabase/dashboard/:id', async (req, res) => {
  try {
    const response = await fetch(`${process.env.METABASE_BASE_URL}/api/dashboard/${req.params.id}`, { headers: mbHeaders });
    const data = await response.json();
    res.json({ success: true, data: { id: data.id, name: data.name, cards: (data.dashcards || []).map(c => ({ id: c.card_id, name: c.card?.name, description: c.card?.description })) } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/metabase/query', async (req, res) => {
  try {
    const response = await fetch(`${process.env.METABASE_BASE_URL}/api/dataset`, {
      method: 'POST', headers: mbHeaders, body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===== CLEVERTAP API =====
const ctRegion = process.env.CLEVERTAP_REGION || 'in1';
const ctBase = `https://${ctRegion}.api.clevertap.com/1`;
const ctHeaders = {
  'X-CleverTap-Account-Id': process.env.CLEVERTAP_ACCOUNT_ID || '',
  'X-CleverTap-Passcode': process.env.CLEVERTAP_PASSCODE || '',
  'Content-Type': 'application/json'
};

// NOTE: ALL CleverTap endpoints are READ-ONLY (aggregate counts only).
// NO campaign modifications. NO PII/user profile access. NO writes of any kind.

// Get aggregate event counts (no PII — only counts/trends)
app.post('/api/clevertap/events', async (req, res) => {
  try {
    const response = await fetch(`${ctBase}/counts/events.json`, { method: 'POST', headers: ctHeaders, body: JSON.stringify(req.body) });
    res.json({ success: true, data: await response.json() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Get top event trends (no PII — only aggregate counts)
app.post('/api/clevertap/trends', async (req, res) => {
  try {
    const response = await fetch(`${ctBase}/counts/top.json`, { method: 'POST', headers: ctHeaders, body: JSON.stringify(req.body) });
    res.json({ success: true, data: await response.json() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


// ===== AGGREGATED OVERVIEW =====
app.get('/api/pulse/overview', async (req, res) => {
  try {
    const results = {};

    // Parallel fetch
    const [shippedData, blockerData, inProgressData, sprintRes] = await Promise.allSettled([
      jiraSearch('status in (Released, Live, "-Live-", "RELEASED TO PROD", Done, "Issue Resolved.") AND updated >= -14d ORDER BY updated DESC', 30),
      jiraSearch('(status in (Blocked, blocked, "Blocked/More Info Needed") OR priority in (Highest, Critical)) AND statusCategory != Done ORDER BY priority DESC', 20),
      jiraSearch('status in ("In Progress", "In dev", "IN DEV", "In Review", "In QA", "IN QA") AND updated >= -14d ORDER BY updated DESC', 30),
      fetch(`${process.env.JIRA_BASE_URL}/rest/agile/1.0/board/32/sprint?state=active`, { headers: jiraHeaders }).then(r => r.json())
    ]);

    // Shipped
    if (shippedData.status === 'fulfilled') {
      const issues = (shippedData.value.issues || []).map(mapIssue);
      results.shipped = issues.length;
      results.shippedIssues = issues.slice(0, 10);
    }

    // Blockers
    if (blockerData.status === 'fulfilled') {
      const issues = (blockerData.value.issues || []).map(mapIssue);
      results.blockers = issues.length;
      results.blockerIssues = issues.slice(0, 10);
    }

    // In Progress
    if (inProgressData.status === 'fulfilled') {
      const issues = (inProgressData.value.issues || []).map(mapIssue);
      results.inProgress = issues.length;
      results.inProgressIssues = issues.slice(0, 10);
    }

    // Sprint info
    if (sprintRes.status === 'fulfilled' && sprintRes.value.values) {
      const activeSprint = sprintRes.value.values[0];
      if (activeSprint) {
        const issuesRes = await fetch(`${process.env.JIRA_BASE_URL}/rest/agile/1.0/sprint/${activeSprint.id}/issue?maxResults=200&fields=summary,status,assignee,issuetype,labels,customfield_10016`, { headers: jiraHeaders });
        const issuesData = await issuesRes.json();
        const sprintIssues = (issuesData.issues || []).map(mapIssue);
        const done = sprintIssues.filter(i => i.statusCategory === 'Done').length;
        results.sprintName = activeSprint.name;
        results.sprintEnd = activeSprint.endDate;
        results.planned = sprintIssues.length;
        results.sprintDone = done;
        results.sprintHealth = sprintIssues.length > 0 ? Math.round((done / sprintIssues.length) * 100) : 0;
        results.upcoming = sprintIssues.filter(i => i.statusCategory !== 'Done').length;
      }
    }

    res.json({ success: true, timestamp: new Date().toISOString(), data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      jira: !!process.env.JIRA_API_TOKEN,
      metabase: !!process.env.METABASE_API_KEY,
      clevertap: !!process.env.CLEVERTAP_PASSCODE
    }
  });
});

// ===== SERVE FRONTEND =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'widget.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Wiom Pulse server running at http://localhost:${PORT}`);
  console.log(`  Widget:      http://localhost:${PORT}/widget.html`);
  console.log(`  Dashboard:   http://localhost:${PORT}/dashboard.html`);
  console.log(`  API Health:  http://localhost:${PORT}/api/health\n`);
});
