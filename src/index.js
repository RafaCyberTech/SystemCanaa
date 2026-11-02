const SHARED_KEYS = [
  "settings",
  "classes",
  "members",
  "attendance",
  "lessons",
  "quarterlyRequests",
  "weeklyReports",
  "programs",
];
const MATERIAL_TYPES = ["foto", "video", "pdf", "link"];
const MAX_FILE_BYTES = 22 * 1024 * 1024;
const SESSION_DAYS = 30;
const LOCK_MINUTES = 15;
const MAX_ATTEMPTS = 5;

function defaultClasses() {
  return [
    { id: "classe-01-adultos", name: "Classe 01-Adultos" },
    { id: "classe-02-adultos", name: "Classe 02-Adultos" },
    { id: "classe-03-adultos", name: "Classe 03-Adultos" },
    { id: "classe-04-adultos", name: "Classe 04-Adultos" },
    { id: "classe-05-adultos", name: "Classe 05-Adultos" },
    { id: "pos-batismal", name: "Pos-Batismal" },
    { id: "batismal", name: "Batismal" },
    { id: "juvenis", name: "Juvenis" },
    { id: "primarios", name: "Primarios" },
    { id: "jardim-de-infancia", name: "Jardim de infancia" },
    { id: "rol-de-berco", name: "Rol de Berco" },
    { id: "adolescentes", name: "Adolescentes" },
  ];
}

function defaultShared() {
  return {
    settings: { attendanceWeight: 50, lessonWeight: 30, participationWeight: 20 },
    classes: defaultClasses(),
    members: [],
    attendance: [],
    lessons: [],
    quarterlyRequests: [],
    weeklyReports: [],
    programs: [],
  };
}

// ---------- Utilitários ----------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const fail = (message, status = 400) => json({ error: message }, status);

const nowISO = () => new Date().toISOString();

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ---------- Palavras-passe (PBKDF2, suportado nos Workers) ----------

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g), (h) => parseInt(h, 16));

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return `${toHex(salt)}:${toHex(bits)}`;
}

async function verifyPassword(password, stored) {
  const [saltHex] = stored.split(":");
  return (await hashPassword(password, fromHex(saltHex))) === stored;
}

// ---------- Autenticação ----------

function tokenFrom(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function currentUser(env, token) {
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.member_id AS memberId
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`
  )
    .bind(token, nowISO())
    .first();
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    memberId: row.memberId ?? null,
  };
}

async function ensureSeed(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  if (row.n === 0) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, name, password_hash, role) VALUES (?, ?, ?, ?, 'secretary')"
    )
      .bind(crypto.randomUUID(), "DIRECAO", "Direção", await hashPassword("@Direcao26"))
      .run();
  }
}

async function login(request, env) {
  await ensureSeed(env);
  const body = await readJson(request);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const user = await env.DB.prepare(
    `SELECT id, username, name, role, password_hash, failed_attempts, locked_until,
            member_id AS memberId
       FROM users WHERE username = ?`
  )
    .bind(username)
    .first();

  if (!user) return fail("Utilizador ou senha inválidos.", 401);

  if (user.locked_until && user.locked_until > nowISO()) {
    return fail("Conta bloqueada temporariamente. Tente novamente dentro de 15 minutos.", 423);
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const attempts = user.failed_attempts + 1;
    const lockedUntil =
      attempts >= MAX_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString()
        : null;
    await env.DB.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
      .bind(attempts >= MAX_ATTEMPTS ? 0 : attempts, lockedUntil, user.id)
      .run();
    return fail("Utilizador ou senha inválidos.", 401);
  }

  await env.DB.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?")
    .bind(user.id)
    .run();

  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, user.id, expiresAt)
    .run();

  return json({ token, user: publicUser(user) });
}

async function changeOwnPassword(request, env, user) {
  const body = await readJson(request);
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (newPassword.length < 6) return fail("A nova senha deve ter pelo menos 6 caracteres.");

  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(user.id)
    .first();
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    return fail("A senha atual está incorreta.");
  }

  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(await hashPassword(newPassword), user.id)
    .run();
  return json({ ok: true });
}

// ---------- Estado partilhado (membros, presenças, lições, etc.) ----------

async function readShared(env) {
  const row = await env.DB.prepare("SELECT value FROM app_state WHERE key = 'shared'").first();
  const stored = row ? JSON.parse(row.value) : {};
  return { ...defaultShared(), ...stored };
}

async function writeShared(env, data) {
  const clean = {};
  SHARED_KEYS.forEach((key) => {
    if (data[key] !== undefined) clean[key] = data[key];
  });
  await env.DB.prepare(
    "INSERT INTO app_state (key, value) VALUES ('shared', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(JSON.stringify(clean))
    .run();
}

// ---------- Contas ----------

async function listAccounts(env) {
  const rows = await env.DB.prepare(
    "SELECT id, username, name, role, member_id AS memberId FROM users ORDER BY name"
  ).all();
  return json({ accounts: rows.results });
}

async function createAccount(request, env) {
  const body = await readJson(request);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const name = String(body.name || "").trim() || username;
  const memberId = body.memberId || null;

  if (!username) return fail("Utilizador obrigatório.");
  if (password.length < 6) return fail("A senha deve ter pelo menos 6 caracteres.");

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?")
    .bind(username)
    .first();
  if (exists) return fail(`O utilizador "${username}" já existe.`, 409);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, username, name, password_hash, role, member_id) VALUES (?, ?, ?, ?, 'member', ?)"
  )
    .bind(id, username, name, await hashPassword(password), memberId)
    .run();

  return json({ account: { id, username, name, role: "member", memberId } }, 201);
}

async function resetAccountPassword(request, env, accountId) {
  const body = await readJson(request);
  const password = String(body.password || body.newPassword || "");
  if (password.length < 6) return fail("A senha deve ter pelo menos 6 caracteres.");

  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?"
  )
    .bind(await hashPassword(password), accountId)
    .run();
  return json({ ok: true });
}

// ---------- Mensagens ----------

function messageRow(r) {
  return {
    id: r.id,
    from: r.from_name,
    fromRole: r.from_role,
    senderUserId: r.sender_user_id,
    target: r.target,
    recipientMemberId: r.recipient_member_id,
    recipientName: r.recipient_name,
    subject: r.subject,
    body: r.body,
    createdAt: r.created_at,
  };
}

async function visibleMessages(env, user) {
  const rows =
    user.role === "secretary"
      ? await env.DB.prepare("SELECT * FROM messages ORDER BY created_at").all()
      : await env.DB.prepare(
          `SELECT * FROM messages
            WHERE sender_user_id = ?
               OR target = 'all'
               OR (target = 'member' AND recipient_member_id = ?)
            ORDER BY created_at`
        )
          .bind(user.id, user.memberId)
          .all();
  return rows.results.map(messageRow);
}

async function sendMessage(request, env, user) {
  const body = await readJson(request);
  const text = String(body.body || "").trim();
  if (!text) return fail("A mensagem não pode estar vazia.");

  let target = String(body.target || "secretary");
  let recipientMemberId = body.recipientMemberId || null;
  let recipientName = body.recipientName || null;

  if (user.role === "member") {
    // Membros só escrevem à direção.
    target = "secretary";
    recipientMemberId = null;
    recipientName = null;
  } else if (target === "member" && !recipientMemberId) {
    return fail("Escolha um membro específico para enviar esta mensagem.");
  }

  await env.DB.prepare(
    `INSERT INTO messages (id, sender_user_id, from_role, from_name, target,
                           recipient_member_id, recipient_name, subject, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      user.id,
      user.role,
      user.name,
      target,
      recipientMemberId,
      recipientName,
      body.subject ? String(body.subject).trim() : null,
      text,
      nowISO()
    )
    .run();

  return json({ messages: await visibleMessages(env, user) }, 201);
}

async function deleteMessage(env, user, messageId) {
  const row = await env.DB.prepare("SELECT sender_user_id FROM messages WHERE id = ?")
    .bind(messageId)
    .first();
  if (!row) return fail("Mensagem não encontrada.", 404);

  const allowed = user.role === "secretary" || row.sender_user_id === user.id;
  if (!allowed) return fail("Só pode remover a sua própria mensagem.", 403);

  await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();
  return json({ messages: await visibleMessages(env, user) });
}

// ---------- Lições eletrónicas (materiais) ----------

function materialRow(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    quarter: r.quarter,
    type: r.type,
    url: r.url,
    hasFile: Boolean(r.has_file),
    fileName: r.file_name,
    mimeType: r.mime_type,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

async function listMaterials(env) {
  const rows = await env.DB.prepare("SELECT * FROM materials ORDER BY created_at DESC").all();
  return json({ materials: rows.results.map(materialRow) });
}

async function createMaterial(request, env, user) {
  const body = await readJson(request);
  const title = String(body.title || "").trim();
  const type = String(body.type || "");
  const url = body.url ? String(body.url).trim() : null;
  const dataBase64 = body.dataBase64 ? String(body.dataBase64).replace(/^data:[^,]*,/, "") : null;

  if (!title) return fail("O título é obrigatório.");
  if (!MATERIAL_TYPES.includes(type)) return fail("Tipo de material inválido.");
  if (!dataBase64 && !url) return fail("Envie um ficheiro ou um link.");

  const id = crypto.randomUUID();
  let fileKey = null;
  let fileName = null;
  let mimeType = null;

  if (dataBase64) {
    const binary = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
    if (binary.byteLength > MAX_FILE_BYTES) {
      return fail("O ficheiro é demasiado grande (máx. ~22MB).", 413);
    }
    fileKey = `materials/${id}`;
    fileName = body.fileName ? String(body.fileName) : "ficheiro";
    mimeType = body.mimeType ? String(body.mimeType) : "application/octet-stream";
    await env.LICOES.put(fileKey, binary, { httpMetadata: { contentType: mimeType } });
  }

  await env.DB.prepare(
    `INSERT INTO materials (id, title, description, quarter, type, url, has_file,
                            file_key, file_name, mime_type, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      title,
      body.description ? String(body.description).trim() : null,
      body.quarter ? String(body.quarter) : null,
      type,
      url,
      fileKey ? 1 : 0,
      fileKey,
      fileName,
      mimeType,
      user.name,
      nowISO()
    )
    .run();

  return json({ ok: true, id }, 201);
}

async function deleteMaterial(env, materialId) {
  const row = await env.DB.prepare("SELECT file_key FROM materials WHERE id = ?")
    .bind(materialId)
    .first();
  if (!row) return fail("Material não encontrado.", 404);

  if (row.file_key) await env.LICOES.delete(row.file_key);
  await env.DB.prepare("DELETE FROM materials WHERE id = ?").bind(materialId).run();
  return json({ ok: true });
}

async function materialFile(env, materialId) {
  const row = await env.DB.prepare(
    "SELECT file_key, file_name, mime_type, has_file FROM materials WHERE id = ?"
  )
    .bind(materialId)
    .first();
  if (!row || !row.has_file) return fail("Ficheiro não encontrado.", 404);

  const object = await env.LICOES.get(row.file_key);
  if (!object) return fail("Ficheiro não encontrado.", 404);

  const name = encodeURIComponent(row.file_name || "ficheiro");
  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

// ---------- Roteamento ----------

async function handleApi(request, env, url) {
  const { pathname: path } = url;
  const method = request.method;

  if (path === "/api/auth/login" && method === "POST") return login(request, env);

  // O ficheiro é aberto por <a href>, que não envia cabeçalhos: aceita o token na query.
  const fileMatch = path.match(/^\/api\/materials\/([^/]+)\/file$/);
  if (fileMatch && method === "GET") {
    const token = tokenFrom(request) || url.searchParams.get("token") || "";
    const user = await currentUser(env, token);
    if (!user) return fail("Não autenticado.", 401);
    return materialFile(env, fileMatch[1]);
  }

  const user = await currentUser(env, tokenFrom(request));
  if (!user) return fail("Não autenticado.", 401);

  const isSecretary = user.role === "secretary";
  const forbidden = () => fail("Sem permissão para esta ação.", 403);

  // Sessão
  if (path === "/api/auth/me" && method === "GET") return json({ user: publicUser(user) });

  if (path === "/api/auth/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(tokenFrom(request)).run();
    return json({ ok: true });
  }

  if (path === "/api/auth/password" && method === "POST") {
    return changeOwnPassword(request, env, user);
  }

  // Estado partilhado
  if (path === "/api/state" && method === "GET") {
    const shared = await readShared(env);
    return json({ ...shared, messages: await visibleMessages(env, user) });
  }

  if (path === "/api/state" && method === "POST") {
    if (!isSecretary) return forbidden();
    await writeShared(env, await readJson(request));
    return json({ ok: true });
  }

  // Contas
  if (path === "/api/accounts" && method === "GET") {
    if (!isSecretary) return forbidden();
    return listAccounts(env);
  }

  if (path === "/api/accounts" && method === "POST") {
    if (!isSecretary) return forbidden();
    return createAccount(request, env);
  }

  const passwordMatch = path.match(/^\/api\/accounts\/([^/]+)\/password$/);
  if (passwordMatch && method === "POST") {
    if (!isSecretary) return forbidden();
    return resetAccountPassword(request, env, passwordMatch[1]);
  }

  const memberAccountMatch = path.match(/^\/api\/accounts\/member\/([^/]+)$/);
  if (memberAccountMatch && method === "DELETE") {
    if (!isSecretary) return forbidden();
    await env.DB.prepare("DELETE FROM users WHERE member_id = ? AND role = 'member'")
      .bind(memberAccountMatch[1])
      .run();
    return json({ ok: true });
  }

  // Mensagens
  if (path === "/api/messages" && method === "GET") {
    return json({ messages: await visibleMessages(env, user) });
  }

  if (path === "/api/messages" && method === "POST") {
    return sendMessage(request, env, user);
  }

  const messageMatch = path.match(/^\/api\/messages\/([^/]+)$/);
  if (messageMatch && method === "DELETE") {
    return deleteMessage(env, user, messageMatch[1]);
  }

  // Lições eletrónicas
  if (path === "/api/materials" && method === "GET") return listMaterials(env);

  if (path === "/api/materials" && method === "POST") {
    if (!isSecretary) return forbidden();
    return createMaterial(request, env, user);
  }

  const materialMatch = path.match(/^\/api\/materials\/([^/]+)$/);
  if (materialMatch && method === "DELETE") {
    if (!isSecretary) return forbidden();
    return deleteMaterial(env, materialMatch[1]);
  }

  return fail("Rota não encontrada.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      console.error(err);
      return fail("Erro interno do servidor.", 500);
    }
  },
};
