/**
 * AI-First Task Manager - Google Apps Script Web App
 * JSON-only, public endpoints, non-sensitive test data only.
 *
 */

const SHEET_TASKS = "Tasks";
const SHEET_REQUESTS = "Requests";
const SHEET_LOGS = "Logs";
const SHEET_CONFIG = "Config";
const SPREADSHEET_ID = "1YKQxE2CysNmBt8t4RBs2Pgl9VilGUK9QoxRB5nNWOtY";

/**
 * Entry points
 **/

function doGet(e) {
  return handleRequest_(e, "GET");
}

function doPost(e) {
  return handleRequest_(e, "POST");
}

/**
 * Router
 **/

function handleRequest_(e, transportMethod) {
  const traceId = newTraceId_();
  const startTs = new Date();

  try {
    const params = (e && e.parameter) ? e.parameter : {};

    // JSON-only guard
    const format = params.format ? String(params.format).toLowerCase() : "json";
    if (format !== "json") {
      return json_(errorBody_(traceId, "FORMAT_NOT_SUPPORTED", "Only format=json is supported", { format }), 400);
    }

    // Prefer query-router param (?path=/...) over pathInfo
    const rawPathInfo = (e && typeof e.pathInfo === "string") ? e.pathInfo : "";
    const normalizedPathInfo =
      rawPathInfo
        ? (rawPathInfo.startsWith("/") ? rawPathInfo : ("/" + rawPathInfo))
        : "";

    const path =
      (params && params.path)
        ? String(params.path)
        : ((normalizedPathInfo && normalizedPathInfo !== "/") ? normalizedPathInfo : "/");

    const methodOverride = params.method ? String(params.method).toUpperCase() : "";
    const method = methodOverride || transportMethod;
    const headers = getHeaders_(e);
    const body = parseJsonBody_(e);
    const tz = getConfig_("timezone") || Session.getScriptTimeZone() || "UTC";

    // Default route: keep small JSON (Actions sometimes probe "/")
    if (method === "GET" && path === "/") {
      return json_({
        ok: true,
        time: formatIso_(new Date(), tz),
        timezone: tz,
        traceId,
        note: "Default route GET /; use ?path=/health&method=GET&format=json"
      }, 200);
    }

    logEvent_("INFO", traceId, "request.start", {
      transportMethod,
      method,
      path,
      hasBody: !!body
    });

    // --- Health ---
    if (method === "GET" && path === "/health") {
      return json_({
        ok: true,
        time: formatIso_(new Date(), tz),
        timezone: tz,
        traceId
      }, 200);
    }

    // --- CRUD endpoints ---
    if (method === "POST" && path === "/tasks") {
      return withIdempotency_(traceId, headers, method, path, body, () => createTask_(traceId, body));
    }

    if (method === "GET" && path === "/tasks") {
      return listTasks_(traceId, params);
    }

    // PATCH /tasks/{id} (also allow POST + ?method=PATCH)
    const patchMatch = path.match(/^\/tasks\/([^\/]+)$/);
    if ((method === "PATCH" || method === "POST") && patchMatch) {
      const taskId = patchMatch[1];
    
      return withIdempotency_(traceId, headers, "PATCH", path, body, () => patchTask_(traceId, taskId, headers, body));
    }

    // POST /tasks/{id}/complete
    const completeMatch = path.match(/^\/tasks\/([^\/]+)\/complete$/);
    if (method === "POST" && completeMatch) {
      const taskId = completeMatch[1];
    
      return withIdempotency_(traceId, headers, method, path, body, () => completeTask_(traceId, taskId));
    }

    // POST /tasks/{id}/snooze
    const snoozeMatch = path.match(/^\/tasks\/([^\/]+)\/snooze$/);
    if (method === "POST" && snoozeMatch) {
      const taskId = snoozeMatch[1];
    
      return withIdempotency_(traceId, headers, method, path, body, () => snoozeTask_(traceId, taskId, body));
    }

    // GET /tasks/next
    if (method === "GET" && path === "/tasks/next") {
      return getNextTask_(traceId, params);
    }

    // GET /analytics/summary
    if (method === "GET" && path === "/analytics/summary") {
      return analyticsSummary_(traceId);
    }

    return json_(errorBody_(traceId, "NOT_FOUND", `No route for ${method} ${path}`, {}), 404);

  } catch (err) {
    logEvent_("ERROR", traceId, "request.exception", {
      message: String(err && err.message ? err.message : err),
      stack: String(err && err.stack ? err.stack : "")
    });
    return json_(errorBody_(traceId, "INTERNAL_ERROR", "Unexpected error", {}), 500);
  } finally {
    const ms = new Date().getTime() - startTs.getTime();
    logEvent_("INFO", traceId, "request.end", { durationMs: ms });
  }
}

/**
 * Idempotency
 **/

function withIdempotency_(traceId, headers, method, path, body, fn) {
  const idemKey = (headers["idempotency-key"] || (body && body.requestId) || "").trim();
  if (!idemKey) {
    return json_(errorBody_(traceId, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header (or requestId) is required for mutating requests", {}), 400);
  }

  const reqSheet = getSheet_(SHEET_REQUESTS);
  const existing = findRequestByKey_(reqSheet, idemKey);
  if (existing) {
    const responseCode = Number(existing.responseCode) || 200;
    let responseBody;
    try {
      responseBody = JSON.parse(existing.responseBody);
    } catch {
      responseBody = { ok: false, error: { code: "CORRUPT_STORED_RESPONSE", message: "Stored responseBody was not valid JSON", details: {} } };
    }
    responseBody.traceId = traceId;
    logEvent_("INFO", traceId, "idempotency.replay", { requestId: idemKey, responseCode });
    return json_(responseBody, responseCode);
  }

  const res = fn();

  const requestHash = sha256_(JSON.stringify({ method, path, body }));
  reqSheet.appendRow([
    idemKey,
    traceId,
    new Date().toISOString(),
    method,
    path,
    requestHash,
    res.code,
    JSON.stringify(res.body)
  ]);

  return json_(res.body, res.code);
}

function findRequestByKey_(sheet, requestId) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;

  const headers = values[0];
  const idxReq = headers.indexOf("requestId");
  const idxCode = headers.indexOf("responseCode");
  const idxBody = headers.indexOf("responseBody");
  const idxTrace = headers.indexOf("traceId");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idxReq]) === requestId) {
      return {
        requestId,
        traceId: values[i][idxTrace],
        responseCode: values[i][idxCode],
        responseBody: values[i][idxBody]
      };
    }
  }
  return null;
}

/**
 * Handlers
 **/

function createTask_(traceId, body) {
  const tz = getConfig_("timezone") || "UTC";
  const now = new Date();

  const v = validateCreate_(body, tz);
  if (!v.ok) return asRes_(400, { ok: false, error: { code: "VALIDATION_ERROR", message: v.message, details: v.details || {} }, traceId });

  const task = normalizeCreate_(body, tz, now);
  const sheet = getSheet_(SHEET_TASKS);
  sheet.appendRow(taskToRow_(task));

  logEvent_("INFO", traceId, "task.created", { taskId: task.taskId });
  return asRes_(201, { ok: true, task, traceId });
}

function listTasks_(traceId, params) {
  const status = params && params.status ? String(params.status).toUpperCase() : null;
  const q = params && params.q ? String(params.q).toLowerCase() : null;
  const limit = params && params.limit ? Math.min(200, Math.max(1, Number(params.limit))) : 50;

  const tasks = readAllTasks_().filter(t => {
    if (status && t.status !== status) return false;
    if (q && !(t.title.toLowerCase().includes(q) || (t.notes || "").toLowerCase().includes(q) || (t.tags || "").toLowerCase().includes(q))) {
      return false;
    }
    return true;
  }).slice(0, limit);

  return json_({ ok: true, tasks, traceId }, 200);
}

function patchTask_(traceId, taskId, headers, body) {
  const tz = getConfig_("timezone") || "UTC";
  if (!body || typeof body !== "object") {
    return asRes_(400, { ok: false, error: { code: "VALIDATION_ERROR", message: "Body must be JSON object", details: {} }, traceId });
  }

  const sheet = getSheet_(SHEET_TASKS);
  const { rowIndex, task, headerMap } = findTask_(sheet, taskId);
  if (!task) return asRes_(404, { ok: false, error: { code: "NOT_FOUND", message: "Task not found", details: { taskId } }, traceId });

  // optimistic concurrency via If-Match
  const ifMatch = (headers["if-match"] || "").trim();
  if (ifMatch) {
    const expected = Number(ifMatch);
    if (Number(task.version) !== expected) {
      return asRes_(409, { ok: false, error: { code: "VERSION_CONFLICT", message: "Task has changed", details: { currentVersion: task.version } }, traceId });
    }
  }

  const v = validatePatch_(body, tz, task);
  if (!v.ok) return asRes_(400, { ok: false, error: { code: "VALIDATION_ERROR", message: v.message, details: v.details || {} }, traceId });

  const updated = applyPatch_(task, body, tz);
  updated.updatedAt = formatIso_(new Date(), tz);
  updated.version = Number(task.version) + 1;

  writeTaskRow_(sheet, rowIndex, headerMap, updated);

  logEvent_("INFO", traceId, "task.patched", { taskId, version: updated.version });
  return asRes_(200, { ok: true, task: updated, traceId });
}

function completeTask_(traceId, taskId) {
  const tz = getConfig_("timezone") || "UTC";
  const sheet = getSheet_(SHEET_TASKS);
  const { rowIndex, task, headerMap } = findTask_(sheet, taskId);
  if (!task) return asRes_(404, { ok: false, error: { code: "NOT_FOUND", message: "Task not found", details: { taskId } }, traceId });

  if (task.status === "COMPLETED") {
    return asRes_(200, { ok: true, task, traceId });
  }

  task.status = "COMPLETED";
  task.updatedAt = formatIso_(new Date(), tz);
  task.version = Number(task.version) + 1;

  writeTaskRow_(sheet, rowIndex, headerMap, task);
  logEvent_("INFO", traceId, "task.completed", { taskId });
  return asRes_(200, { ok: true, task, traceId });
}

function snoozeTask_(traceId, taskId, body) {
  const tz = getConfig_("timezone") || "UTC";
  const sheet = getSheet_(SHEET_TASKS);
  const { rowIndex, task, headerMap } = findTask_(sheet, taskId);
  if (!task) return asRes_(404, { ok: false, error: { code: "NOT_FOUND", message: "Task not found", details: { taskId } }, traceId });

  if (!body || !body.until) {
    return asRes_(400, { ok: false, error: { code: "VALIDATION_ERROR", message: "Field 'until' (ISO datetime) is required", details: {} }, traceId });
  }
  const until = parseIso_(body.until);
  if (!until) {
    return asRes_(400, { ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid ISO datetime for 'until'", details: { until: body.until } }, traceId });
  }

  task.snoozedUntil = formatIso_(until, tz);
  task.updatedAt = formatIso_(new Date(), tz);
  task.version = Number(task.version) + 1;

  writeTaskRow_(sheet, rowIndex, headerMap, task);
  logEvent_("INFO", traceId, "task.snoozed", { taskId, snoozedUntil: task.snoozedUntil });
  return asRes_(200, { ok: true, task, traceId });
}

function getNextTask_(traceId, params) {
  const tz = getConfig_("timezone") || "UTC";
  const nowIso = params && params.now ? String(params.now) : null;

  // Allow now without timezone
  const now = nowIso ? parseIso_(nowIso) : new Date();
  if (!now) return json_({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid now parameter", details: { now: nowIso } }, traceId }, 400);

  const tasks = readAllTasks_();
  const ctx = computeContext_(now, tz);

  const eligible = tasks.filter(t => isEligible_(t, now, ctx));
  const scored = eligible.map(t => {
    const s = scoreTask_(t, now, ctx);
    return { task: t, score: s.score, explain: s.explain };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.task.dueAt ? parseIso_(a.task.dueAt) : null;
    const bd = b.task.dueAt ? parseIso_(b.task.dueAt) : null;
    if (ad && bd && ad.getTime() !== bd.getTime()) return ad.getTime() - bd.getTime();
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    if (Number(b.task.priority) !== Number(a.task.priority)) return Number(b.task.priority) - Number(a.task.priority);
    const ac = a.task.createdAt ? parseIso_(a.task.createdAt) : new Date(0);
    const bc = b.task.createdAt ? parseIso_(b.task.createdAt) : new Date(0);
    return ac.getTime() - bc.getTime();
  });

  const best = scored.length ? scored[0] : null;
  const alternatives = scored.slice(1, 4).map(x => ({ taskId: x.task.taskId, score: x.score }));

  // Update lastSuggestedAt for best
  if (best) {
    try {
      const sheet = getSheet_(SHEET_TASKS);
      const found = findTask_(sheet, best.task.taskId);
      if (found.task) {
        found.task.lastSuggestedAt = formatIso_(now, tz);
        found.task.updatedAt = formatIso_(new Date(), tz);
        found.task.version = Number(found.task.version) + 1;
        writeTaskRow_(sheet, found.rowIndex, found.headerMap, found.task);
      }
    } catch (e) {
      logEvent_("WARN", traceId, "lastSuggestedAt.update_failed", { message: String(e) });
    }
  }

  return json_({
    ok: true,
    now: formatIso_(now, tz),
    timezone: tz,
    context: ctx,
    candidateCount: eligible.length,
    best: best ? { task: best.task, score: best.score, explain: best.explain } : null,
    alternatives,
    traceId
  }, 200);
}

function analyticsSummary_(traceId) {
  const tz = getConfig_("timezone") || "UTC";
  const now = new Date();
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const tasks = readAllTasks_();
  const active = tasks.filter(t => t.status === "ACTIVE").length;
  const snoozed = tasks.filter(t => t.status === "ACTIVE" && t.snoozedUntil && parseIso_(t.snoozedUntil) && parseIso_(t.snoozedUntil) > now).length;

  const completed7d = tasks.filter(t => {
    if (t.status !== "COMPLETED") return false;
    const upd = t.updatedAt ? parseIso_(t.updatedAt) : null;
    return upd && upd >= since7d;
  }).length;

  const overdue = tasks.filter(t => {
    if (t.status !== "ACTIVE") return false;
    const due = t.dueAt ? parseIso_(t.dueAt) : null;
    return due && due < now;
  }).length;

  return json_({
    ok: true,
    now: formatIso_(now, tz),
    active,
    snoozed,
    overdue,
    completed7d,
    traceId
  }, 200);
}

/**
 * Relevance logic
 **/

function isEligible_(t, now, ctx) {
  if (!t || t.status !== "ACTIVE") return false;

  if (t.startAt) {
    const st = parseIso_(t.startAt);
    if (st && now < st) return false;
  }

  if (t.snoozedUntil) {
    const sn = parseIso_(t.snoozedUntil);
    if (sn && now < sn) return false;
  }

  if (t.contextDays && String(t.contextDays).trim()) {
    const allowed = String(t.contextDays).split(",").map(x => x.trim());
    if (allowed.length && allowed[0] !== "" && allowed.indexOf(ctx.weekdayShort) === -1) return false;
  }

  if (t.contextTimes && String(t.contextTimes).trim()) {
    const allowed = String(t.contextTimes).split(",").map(x => x.trim().toUpperCase());
    if (allowed.length && allowed[0] !== "" && allowed.indexOf(ctx.timeBucket) === -1) return false;
  }

  return true;
}

function scoreTask_(t, now, ctx) {
  let score = 0;
  const explain = [];

  // Due urgency (0-40)
  let duePts = 0;
  if (t.dueAt) {
    const due = parseIso_(t.dueAt);
    if (due) {
      const diffMs = due.getTime() - now.getTime();
      const diffH = diffMs / (1000 * 60 * 60);
      if (diffH < 0) duePts = 40;
      else if (diffH <= 4) duePts = 30;
      else if (diffH <= 24) duePts = 20;
      else duePts = 10;
      score += duePts;
      explain.push({ rule: "due_urgency", value: `+${duePts} (due in ${Math.round(diffH * 10) / 10}h)` });
    }
  } else {
    explain.push({ rule: "due_urgency", value: "+0 (no dueAt)" });
  }

  // Priority (0-25)
  const p = clampInt_(Number(t.priority || 1), 1, 5);
  const pPts = p * 5;
  score += pPts;
  explain.push({ rule: "priority", value: `+${pPts} (p${p})` });

  // Effort fit (0-10)
  let ePts = 0;
  if (t.effortMins) {
    const e = Number(t.effortMins);
    if (ctx.timeBucket === "MORNING") {
      ePts = (e >= 30 && e <= 90) ? 10 : 5;
    } else {
      ePts = 5;
    }
    score += ePts;
    explain.push({ rule: "effort_fit", value: `+${ePts} (${e} mins)` });
  } else {
    explain.push({ rule: "effort_fit", value: "+0 (no effort)" });
  }

  // Context match (0-15)
  let cPts = 0;
  if (t.contextDays && String(t.contextDays).trim()) cPts += 5;
  if (t.contextTimes && String(t.contextTimes).trim()) cPts += 10;
  score += cPts;
  explain.push({ rule: "context_match", value: `+${cPts} (bucket=${ctx.timeBucket}, day=${ctx.weekdayShort})` });

  // Anti-repeat (-20..0)
  const cooldownMins = Number(getConfig_("repeatCooldownMins") || 120);
  if (t.lastSuggestedAt) {
    const ls = parseIso_(t.lastSuggestedAt);
    if (ls) {
      const diffMin = (now.getTime() - ls.getTime()) / (1000 * 60);
      if (diffMin >= 0 && diffMin <= cooldownMins) {
        score += -20;
        explain.push({ rule: "repeat_cooldown", value: `-20 (suggested ${Math.round(diffMin)}m ago)` });
      } else {
        explain.push({ rule: "repeat_cooldown", value: "+0 (not recent)" });
      }
    }
  } else {
    explain.push({ rule: "repeat_cooldown", value: "+0 (never suggested)" });
  }

  return { score, explain };
}

function computeContext_(now, tz) {
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayShort = WEEKDAYS[now.getDay()];
  const hm = Utilities.formatDate(now, tz, "HH:mm");
  const morningStart = getConfigTimeHHmm_("morningStart", "05:00");
  const morningEnd = getConfigTimeHHmm_("morningEnd", "11:59");
  const afternoonEnd = getConfigTimeHHmm_("afternoonEnd", "17:59");
  const eveningEnd = getConfigTimeHHmm_("eveningEnd", "23:59");
  const timeBucket =
    (hm >= morningStart && hm <= morningEnd) ? "MORNING" :
    (hm > morningEnd && hm <= afternoonEnd) ? "AFTERNOON" :
    (hm > afternoonEnd && hm <= eveningEnd) ? "EVENING" :
    "NIGHT";

  return { weekdayShort, timeBucket, hm, morningStart, morningEnd, afternoonEnd, eveningEnd };
}

/**
 * Validation + normalization
 **/

function validateCreate_(body, tz) {
  if (!body || typeof body !== "object") return { ok: false, message: "Body must be JSON object", details: {} };
  if (!body.title || !String(body.title).trim()) return { ok: false, message: "title is required", details: {} };

  const title = String(body.title).trim();
  if (title.length > 140) return { ok: false, message: "title too long (max 140)", details: { max: 140 } };

  if (body.priority != null) {
    const p = Number(body.priority);
    if (!(p >= 1 && p <= 5)) return { ok: false, message: "priority must be 1..5", details: { priority: body.priority } };
  }

  const startAt = body.startAt ? parseIso_(body.startAt) : null;
  const dueAt = body.dueAt ? parseIso_(body.dueAt) : null;

  if (body.startAt && !startAt) return { ok: false, message: "Invalid startAt ISO datetime", details: { startAt: body.startAt } };
  if (body.dueAt && !dueAt) return { ok: false, message: "Invalid dueAt ISO datetime", details: { dueAt: body.dueAt } };
  if (startAt && dueAt && dueAt < startAt) return { ok: false, message: "dueAt must be >= startAt", details: {} };

  return { ok: true };
}

function validatePatch_(patch, tz, existing) {
  const allowed = ["title","notes","status","priority","effortMins","tags","startAt","dueAt","snoozedUntil","contextDays","contextTimes"];

  Object.keys(patch).forEach(k => {
    if (allowed.indexOf(k) === -1) throw new Error("Unsupported patch field: " + k);
  });

  if (patch.title != null) {
    const title = String(patch.title).trim();
  
    if (!title) return { ok: false, message: "title cannot be empty", details: {} };
    if (title.length > 140) return { ok: false, message: "title too long (max 140)", details: { max: 140 } };
  }

  if (patch.status != null) {
    const s = String(patch.status).toUpperCase();
  
    if (["ACTIVE","COMPLETED","CANCELED"].indexOf(s) === -1) {
      return { ok: false, message: "status must be ACTIVE|COMPLETED|CANCELED", details: { status: patch.status } };
    }
  }

  if (patch.priority != null) {
    const p = Number(patch.priority);
  
    if (!(p >= 1 && p <= 5)) return { ok: false, message: "priority must be 1..5", details: { priority: patch.priority } };
  }

  const startAt = patch.startAt != null ? (patch.startAt ? parseIso_(patch.startAt) : null) : (existing.startAt ? parseIso_(existing.startAt) : null);
  const dueAt = patch.dueAt != null ? (patch.dueAt ? parseIso_(patch.dueAt) : null) : (existing.dueAt ? parseIso_(existing.dueAt) : null);

  if (patch.startAt && !parseIso_(patch.startAt)) return { ok: false, message: "Invalid startAt ISO datetime", details: { startAt: patch.startAt } };
  if (patch.dueAt && !parseIso_(patch.dueAt)) return { ok: false, message: "Invalid dueAt ISO datetime", details: { dueAt: patch.dueAt } };
  if (startAt && dueAt && dueAt < startAt) return { ok: false, message: "dueAt must be >= startAt", details: {} };
  if (patch.snoozedUntil && !parseIso_(patch.snoozedUntil)) return { ok: false, message: "Invalid snoozedUntil ISO datetime", details: { snoozedUntil: patch.snoozedUntil } };

  return { ok: true };
}

function normalizeCreate_(body, tz, now) {
  const taskId = newTaskId_();
  const createdAt = formatIso_(now, tz);
  const tags = Array.isArray(body.tags) ? body.tags.join(",") : (body.tags ? String(body.tags) : "");
  const contextDays = Array.isArray(body.contextDays) ? body.contextDays.join(",") : (body.contextDays ? String(body.contextDays) : "");
  const contextTimes = Array.isArray(body.contextTimes) ? body.contextTimes.join(",") : (body.contextTimes ? String(body.contextTimes).toUpperCase() : "");

  return {
    taskId,
    title: String(body.title).trim(),
    notes: body.notes ? String(body.notes) : "",
    status: "ACTIVE",
    priority: body.priority != null ? clampInt_(Number(body.priority), 1, 5) : 3,
    effortMins: body.effortMins != null ? clampInt_(Number(body.effortMins), 1, 1440) : "",
    tags,
    createdAt,
    updatedAt: createdAt,
    startAt: body.startAt ? formatIso_(parseIso_(body.startAt), tz) : "",
    dueAt: body.dueAt ? formatIso_(parseIso_(body.dueAt), tz) : "",
    snoozedUntil: "",
    lastSuggestedAt: "",
    contextDays,
    contextTimes,
    source: body.source ? String(body.source) : "gpt",
    version: 1
  };
}

function applyPatch_(task, patch, tz) {
  const out = Object.assign({}, task);
  if (patch.title != null) out.title = String(patch.title).trim();
  if (patch.notes != null) out.notes = String(patch.notes);
  if (patch.status != null) out.status = String(patch.status).toUpperCase();
  if (patch.priority != null) out.priority = clampInt_(Number(patch.priority), 1, 5);
  if (patch.effortMins != null) out.effortMins = patch.effortMins === "" ? "" : clampInt_(Number(patch.effortMins), 1, 1440);
  if (patch.tags != null) out.tags = Array.isArray(patch.tags) ? patch.tags.join(",") : String(patch.tags);
  if (patch.startAt != null) out.startAt = patch.startAt ? formatIso_(parseIso_(patch.startAt), tz) : "";
  if (patch.dueAt != null) out.dueAt = patch.dueAt ? formatIso_(parseIso_(patch.dueAt), tz) : "";
  if (patch.snoozedUntil != null) out.snoozedUntil = patch.snoozedUntil ? formatIso_(parseIso_(patch.snoozedUntil), tz) : "";
  if (patch.contextDays != null) out.contextDays = Array.isArray(patch.contextDays) ? patch.contextDays.join(",") : String(patch.contextDays);
  if (patch.contextTimes != null) out.contextTimes = Array.isArray(patch.contextTimes) ? patch.contextTimes.join(",") : String(patch.contextTimes).toUpperCase();

  return out;
}

/**
 * Sheet access helpers
 **/

function readAllTasks_() {
  const sheet = getSheet_(SHEET_TASKS);
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) return [];
  const headers = values[0].map(String);
  const out = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[0]) continue;
    const t = {};
    for (let c = 0; c < headers.length; c++) {
      t[headers[c]] = row[c] != null ? String(row[c]) : "";
    }
    t.priority = t.priority ? Number(t.priority) : 3;
    t.version = t.version ? Number(t.version) : 1;
    out.push(t);
  }
  return out;
}

function findTask_(sheet, taskId) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const headerMap = {};

  headers.forEach((h, i) => headerMap[h] = i);

  const idCol = headerMap["taskId"];

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === taskId) {
      const t = {};
      headers.forEach((h, idx) => t[h] = values[i][idx] != null ? String(values[i][idx]) : "");
      t.priority = t.priority ? Number(t.priority) : 3;
      t.version = t.version ? Number(t.version) : 1;
      return { rowIndex: i + 1, task: t, headerMap };
    }
  }
  return { rowIndex: -1, task: null, headerMap };
}

function writeTaskRow_(sheet, rowIndex, headerMap, task) {
  const headers = Object.keys(headerMap);
  const row = new Array(headers.length);

  headers.forEach(h => {
    row[headerMap[h]] = task[h] != null ? task[h] : "";
  });
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
}

function taskToRow_(task) {
  return [
    task.taskId,
    task.title,
    task.notes,
    task.status,
    task.priority,
    task.effortMins,
    task.tags,
    task.createdAt,
    task.updatedAt,
    task.startAt,
    task.dueAt,
    task.snoozedUntil,
    task.lastSuggestedAt,
    task.contextDays,
    task.contextTimes,
    task.source,
    task.version
  ];
}

/**
 * Utilities
 **/

function getSheet_(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(name);

  if (!sheet) throw new Error("Missing sheet: " + name);
  return sheet;
}

function getConfig_(key) {
  const sheet = getSheet_(SHEET_CONFIG);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === key) return String(values[i][1]).trim();
  }
  return "";
}

// Raw config value (preserves Date/number types from Sheets)
function getConfigRaw_(key) {
  const sheet = getSheet_(SHEET_CONFIG);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === key) return values[i][1];
  }
  return "";
}

// Robustly convert Config times (text/time/date/number) into "HH:mm"
function getConfigTimeHHmm_(key, fallback) {
  const raw = getConfigRaw_(key);

  if (raw == null || raw === "") return fallback;

  // string like "5:00" / "05:00" possibly with spaces
  if (typeof raw === "string") {
    const s = raw.trim();
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
  
    if (m) {
      const hh = String(Math.min(23, Math.max(0, parseInt(m[1], 10)))).padStart(2, "0");
      const mm = String(Math.min(59, Math.max(0, parseInt(m[2], 10)))).padStart(2, "0");
  
      return `${hh}:${mm}`;
    }
  }

  // Date object (Sheets time)
  if (Object.prototype.toString.call(raw) === "[object Date]" && !isNaN(raw.getTime())) {
    const tz = getConfig_("timezone") || "UTC";
  
    return Utilities.formatDate(raw, tz, "HH:mm");
  }

  // number (Sheets time fraction of day)
  if (typeof raw === "number" && isFinite(raw)) {
    const totalMins = Math.round(raw * 24 * 60);
    const hh = String(Math.floor(totalMins / 60) % 24).padStart(2, "0");
    const mm = String(totalMins % 60).padStart(2, "0");
  
    return `${hh}:${mm}`;
  }

  return fallback;
}

function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  const raw = e.postData.contents;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getHeaders_(e) {
  const h = {};
  const params = (e && e.parameter) ? e.parameter : {};

  if (params.idempotencyKey) h["idempotency-key"] = String(params.idempotencyKey);
  if (params.ifMatch) h["if-match"] = String(params.ifMatch);

  return h;
}

function json_(obj, code) {
  const status = Number(code || 200);
  if (obj && typeof obj === "object") obj._httpCode = status;
  const out = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);

  // Helpful for some clients; safe to try/catch.
  try { out.setResponseCode(status); } catch (_) {}
  try {
    out.setHeader("Cache-Control", "no-store");
    out.setHeader("Content-Type", "application/json; charset=utf-8");
  } catch (_) {}

  return out;
}

function asRes_(code, body) {
  if (body && typeof body === "object") body._httpCode = code;
  return { code, body };
}

function errorBody_(traceId, code, message, details) {
  return { ok: false, error: { code, message, details: details || {} }, traceId };
}

function logEvent_(level, traceId, event, details) {
  try {
    const sheet = getSheet_(SHEET_LOGS);
    sheet.appendRow([new Date().toISOString(), traceId, level, event, JSON.stringify(details || {})]);
  } catch (_) {}
}

function newTraceId_() {
  return "trc_" + Utilities.getUuid().replace(/-/g, "").slice(0, 16);
}

function newTaskId_() {
  const ts = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd_HHmmss");
  const rnd = Math.floor(Math.random() * 10000).toString().padStart(4, "0");

  return `tsk_${ts}_${rnd}`;
}

function parseIso_(s) {
  if (!s) return null;
  const d = new Date(String(s));
  if (isNaN(d.getTime())) return null;
  return d;
}

function formatIso_(d, tz) {
  if (!d) return "";
  return Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function clampInt_(n, min, max) {
  const x = Math.floor(Number(n));

  if (isNaN(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function sha256_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);

  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}