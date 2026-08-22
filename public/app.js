const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const socket = io();

let currentUser = null;
let partner = null;

async function api(url, options = {}) {
    options = Object.assign({ credentials: "same-origin" }, options);
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
}

async function init() {
    const data = await api("/api/me");
    if (data.user) {
        currentUser = data.user;
        partner = data.partner;
        showApp();
    } else {
        $("#loginView").classList.remove("hidden");
    }
}

function showApp() {
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    updateWelcome();
    loadAll();
    // Ask the user how they'd like to be addressed and which role they are, if not set
    (async() => {
        try {
            if (!currentUser.preferred_name) {
                const pref = prompt("How should your partner address you? (e.g. Babe, Love)");
                if (pref && pref.trim()) {
                    await api("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferred_name: pref.trim() }) });
                }
            }
            if (!currentUser.role) {
                let role = null;
                while (!role) {
                    const r = prompt("Which role are you? Type 'boyfriend' or 'girlfriend' (case-insensitive)");
                    if (!r) break;
                    const rv = r.trim().toLowerCase();
                    if (rv === 'boyfriend' || rv === 'girlfriend') { role = rv; break; }
                    alert("Please enter either 'boyfriend' or 'girlfriend'.");
                }
                if (role) {
                    await api('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
                }
            }
            const me = await api("/api/me");
            currentUser = me.user;
            partner = me.partner;
            updateWelcome();
        } catch (e) { console.error(e); }
    })();
}

function updateWelcome() {
    const partnerLabel = partner ? .preferred_name || partner ? .name || "";
    const activeTab = document.querySelector('.tab.active') ? .dataset ? .tab || 'messages';
    const tabLabel = activeTab === 'messages' ? 'texting' : activeTab === 'plans' ? 'planning with' : 'reviewing requests with';
    $("#welcome").textContent = `${currentUser.name} · ${tabLabel} ${partnerLabel ? `(${partnerLabel})` : ''}`;
}

async function loadAll() {
    await Promise.all([loadMessages(), loadPlans(), loadRequests()]);
}

$("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("#loginError").textContent = "";
    try {
        const data = await api("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: $("#userId").value, password: $("#password").value })
        });
        const me = await api("/api/me");
        currentUser = me.user;
        partner = me.partner;
        showApp();
    } catch (err) { $("#loginError").textContent = err.message; }
});

$("#logoutBtn").addEventListener("click", async() => {
    await api("/api/logout", { method: "POST" });
    location.reload();
});

$$(".tab").forEach(btn => btn.addEventListener("click", () => {
    $$(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".panel").forEach(p => p.classList.add("hidden"));
    $("#" + btn.dataset.tab).classList.remove("hidden");
    updateWelcome();
}));

$("#unlockMethod").addEventListener("change", () => {
    const show = ["question", "either"].includes($("#unlockMethod").value);
    $("#questionFields").classList.toggle("hidden", !show);
});

$("#messageForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("#messageError").textContent = "";
    try {
        await api("/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                body: $("#messageBody").value,
                unlock_method: $("#unlockMethod").value,
                question: $("#question").value,
                answer: $("#answer").value
            })
        });
        e.target.reset();
        $("#questionFields").classList.add("hidden");
        await loadMessages();
    } catch (err) { $("#messageError").textContent = err.message; }
});

async function loadMessages() {
    const messages = await api("/api/messages");
    const list = $("#messageList");
    list.innerHTML = "";
    if (!messages.length) {
        list.innerHTML = `<div class="card muted">No messages yet. Send the first one ♥</div>`;
        return;
    }

    for (const m of messages) {
        const wrap = document.createElement("div");
        wrap.className = "message " + (m.sender === currentUser.id ? "mine" : "");
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${m.sender === currentUser.id ? "You" : partner.name} · ${new Date(m.created_at.replace(" ","T")+"Z").toLocaleString()}`;
        // show seen indicator for messages you sent
        if (m.sender === currentUser.id) {
            const seenEl = document.createElement("span");
            seenEl.className = "seen-indicator";
            seenEl.textContent = m.seen ? " · Seen" : "";
            meta.appendChild(seenEl);
        }
        wrap.appendChild(meta);

        if (!m.locked) {
            const body = document.createElement("div");
            body.className = "body";
            body.textContent = m.body;
            wrap.appendChild(body);
            // if we're the recipient and this is an unlocked message, mark it seen
            if (m.recipient === currentUser.id && !m.seen) {
                api(`/api/messages/${m.id}/seen`, { method: "POST" }).catch(() => {});
            }
        } else {
            const locked = $("#lockedTemplate").content.cloneNode(true);
            const methodText = locked.querySelector(".method-text");
            const challenge = locked.querySelector(".challenge");
            const method = m.unlock_method;
            methodText.textContent =
                method === "question" ? "Answer the question below to reveal it." :
                method === "photo" ? "Send a photo to your partner for approval." :
                "Answer the question OR send a photo for approval.";

            if (["question", "either"].includes(method)) {
                const box = document.createElement("div");
                box.innerHTML = `<p><strong>${escapeHtml(m.question || "")}</strong></p>
          <div class="challenge-row"><input placeholder="Your answer"><button class="primary">Unlock</button></div>
          <p class="error"></p>`;
                const input = box.querySelector("input");
                box.querySelector("button").onclick = async() => {
                    try {
                        await api(`/api/messages/${m.id}/answer`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ answer: input.value })
                        });
                        loadMessages();
                    } catch (err) { box.querySelector(".error").textContent = err.message; }
                };
                challenge.appendChild(box);
            }

            if (["photo", "either"].includes(method)) {
                const box = document.createElement("div");
                box.style.marginTop = "10px";
                box.innerHTML = `<input type="file" accept="image/jpeg,image/png,image/webp"><button class="primary" style="margin-top:8px">Send photo proof</button><p class="error"></p>`;
                const file = box.querySelector("input");
                box.querySelector("button").onclick = async() => {
                    if (!file.files[0]) return box.querySelector(".error").textContent = "Choose a photo first.";
                    const fd = new FormData();
                    fd.append("photo", file.files[0]);
                    try {
                        await api(`/api/messages/${m.id}/photo`, { method: "POST", body: fd });
                        box.querySelector(".error").textContent = "Photo sent. Waiting for approval.";
                        loadRequests();
                    } catch (err) { box.querySelector(".error").textContent = err.message; }
                };
                challenge.appendChild(box);
            }
            wrap.appendChild(locked);
        }
        list.appendChild(wrap);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

$("#planForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("#planError").textContent = "";
    try {
        await api("/api/plans", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: $("#planTitle").value,
                plan_date: $("#planDate").value,
                plan_time: $("#planTime").value,
                place: $("#planPlace").value,
                notes: $("#planNotes").value
            })
        });
        e.target.reset();
        loadPlans();
    } catch (err) { $("#planError").textContent = err.message; }
});

async function loadPlans() {
    const plans = await api("/api/plans");
    const list = $("#planList");
    list.innerHTML = "";
    if (!plans.length) {
        list.innerHTML = `<div class="card muted">No plans saved yet.</div>`;
        return;
    }
    plans.forEach(p => {
                const el = document.createElement("div");
                el.className = "card plan " + (p.completed ? "done" : "");
                el.innerHTML = `
      <span class="badge">${p.completed ? "Completed" : "Plan"}</span>
      <h3>${escapeHtml(p.title)}</h3>
      ${p.plan_date ? `<div class="date">📅 ${escapeHtml(p.plan_date)} ${p.plan_time ? "· "+escapeHtml(p.plan_time) : ""}</div>` : ""}
      ${p.place ? `<p>📍 ${escapeHtml(p.place)}</p>` : ""}
      ${p.notes ? `<p class="muted">${escapeHtml(p.notes)}</p>` : ""}
      <div class="plan-actions">
        <button class="ghost toggle">${p.completed ? "Mark active" : "Mark done"}</button>
        <button class="ghost delete">Delete</button>
      </div>`;
    el.querySelector(".toggle").onclick = async () => {
      await api(`/api/plans/${p.id}`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({...p,completed:!p.completed})});
      loadPlans();
    };
    el.querySelector(".delete").onclick = async () => {
      if(confirm("Delete this plan?")) { await api(`/api/plans/${p.id}`,{method:"DELETE"}); loadPlans(); }
    };
    list.appendChild(el);
  });
}

async function loadRequests() {
  const requests = await api("/api/photo-requests");
  const list = $("#requestList");
  list.innerHTML = "";
  if (!requests.length) {
    list.innerHTML = `<div class="card muted">No photo requests yet.</div>`;
    return;
  }
  requests.forEach(r => {
    const el = document.createElement("div");
    el.className = "card request";
    const photoUrl = `/uploads/${encodeURIComponent(r.filename)}`;
    const status = r.status;
    el.innerHTML = `
      <div>
        <div class="badge">${status}</div>
        <h3>${r.reader === currentUser.id ? "Your photo proof" : "Photo proof from "+escapeHtml(partner.name)}</h3>
        <p class="muted">Message: ${escapeHtml(r.message_preview.slice(0,100))}${r.message_preview.length>100?"…":""}</p>
        ${r.sender === currentUser.id && status === "pending" ? `
          <div class="request-actions">
            <button class="primary approve">Approve & reveal</button>
            <button class="ghost reject">Reject</button>
          </div>` : ""}
      </div>
      <img src="${photoUrl}" alt="Photo proof">`;
    if (r.sender === currentUser.id && status === "pending") {
      el.querySelector(".approve").onclick = async () => { await api(`/api/photo-requests/${r.id}/approve`,{method:"POST"}); loadAll(); };
      el.querySelector(".reject").onclick = async () => { await api(`/api/photo-requests/${r.id}/reject`,{method:"POST"}); loadRequests(); };
    }
    list.appendChild(el);
  });
}

socket.on("refresh", loadAll);
init();