/* Fern Tasks – sync layer (Firebase Auth email/password + Firestore) */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const overlay = $("fsOverlay"), dot = $("syncDot");
  const DIRTY_KEY = "fern_sync_dirty_at";
  const SKIP_KEY = "fern_sync_skip";
  const NOTES_ONLY = !!(window.fernNotes && window.fernNotes.NOTES_ONLY);   // pop-out notes window: sync notes only

  let status = "local", statusText = "Not syncing - this device only.";
  function setStatus(s, text) {
    status = s; statusText = text;
    dot.className = "sync-dot" + (s === "ok" ? " ok" : s === "busy" ? " busy" : s === "err" ? " err" : "");
    const st = $("fsState"); if (st) st.textContent = text;
    $("acctBtn").title = "Sync: " + text;
  }
  function showOverlay(mode) {
    $("fsForm").hidden = mode !== "signin";
    $("fsAcct").hidden = mode !== "account";
    $("fsMsg").textContent = mode === "signin"
      ? "Sign in to sync your tasks across your phone and computer."
      : "Syncing is on.";
    overlay.classList.add("show");
    if (mode === "signin") setTimeout(() => $("fsEmail").focus(), 50);
  }
  function hideOverlay() { overlay.classList.remove("show"); }

  // ---- config ----
  let cfg = window.FERN_FIREBASE_CONFIG || null;
  try { if (!cfg && typeof firebaseConfig !== "undefined") cfg = firebaseConfig; } catch (e) {}
  const configured = !!(cfg && cfg.apiKey && !/PASTE/i.test(cfg.apiKey));

  if (!configured || !window.firebase) {
    window.fernSync = { changed() {}, notesChanged() {}, flushNotes() {} };
    setStatus("local", !configured
      ? "Sync not set up yet (firebase-config.js)."
      : "Couldn't load sync - working on this device only.");
    $("acctBtn").addEventListener("click", () =>
      alert(statusText + "\n\nYour tasks are still saved on this device."));
    return;
  }

  firebase.initializeApp(cfg);
  const auth = firebase.auth(), db = firebase.firestore();
  try { db.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}

  let docRef = null, unsub = null, applyingRemote = false, pushTimer = null;
  let lastSynced = "";
  let dirtyAt = +localStorage.getItem(DIRTY_KEY) || 0;
  const setDirty = (v) => { dirtyAt = v; if (v) localStorage.setItem(DIRTY_KEY, String(v)); else localStorage.removeItem(DIRTY_KEY); };
  const snapshotData = () => JSON.stringify({ tasks, categories, sectionState });

  function push() {
    if (!docRef) return;
    const data = snapshotData();
    if (data === lastSynced) { setDirty(0); setStatus("ok", "Synced."); return; }
    const stamp = dirtyAt || Date.now();
    setStatus("busy", navigator.onLine ? "Saving..." : "Offline - will sync when you reconnect.");
    docRef.set({ data, editedAt: stamp, savedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
      .then(() => { lastSynced = data; if (dirtyAt === stamp) setDirty(0); setStatus("ok", "Synced."); })
      .catch((e) => setStatus("err", "Sync error: " + (e && e.message ? e.message : e)));
  }

  // ---- notes: stored in the same document (field "notesData"), merged note-by-note, newest edit wins ----
  let lastNotesSynced = null, notesTimer = null;
  function pushNotes() {
    clearTimeout(notesTimer); notesTimer = null;
    if (!docRef || !window.fernNotes) return;
    const data = window.fernNotes.serialize();
    if (data === lastNotesSynced) return;
    setStatus("busy", navigator.onLine ? "Saving..." : "Offline - will sync when you reconnect.");
    docRef.set({ notesData: data, notesAt: Date.now() }, { merge: true })
      .then(() => { lastNotesSynced = data; setStatus("ok", "Synced."); })
      .catch((e) => setStatus("err", "Sync error: " + (e && e.message ? e.message : e)));
  }
  function syncNotes(d) {
    if (!window.fernNotes) return;
    if (typeof d.notesData === "string") {
      if (d.notesData === lastNotesSynced) return;
      const cloudMissingSomething = window.fernNotes.mergeRemote(d.notesData);
      lastNotesSynced = d.notesData;
      if (cloudMissingSomething) { clearTimeout(notesTimer); notesTimer = setTimeout(pushNotes, 400); }
    } else if (window.fernNotes.serialize() !== "[]") {
      lastNotesSynced = null; pushNotes();                                                          // cloud has no notes yet: upload ours
    }
  }

  window.fernSync = {
    changed() {
      if (applyingRemote || NOTES_ONLY) return;
      setDirty(Date.now());
      clearTimeout(pushTimer); pushTimer = setTimeout(push, 700);
    },
    notesChanged() { clearTimeout(notesTimer); notesTimer = setTimeout(pushNotes, 1200); },
    flushNotes() { if (notesTimer) pushNotes(); }
  };

  function applyRemote(obj, raw) {
    applyingRemote = true;
    try {
      tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
      if (Array.isArray(obj.categories) && obj.categories.length) categories = obj.categories;
      if (obj.sectionState && typeof obj.sectionState === "object") sectionState = obj.sectionState;
      migrate(); refileByDate(); renderCategoryUI(); save(); render();
    } finally { applyingRemote = false; }
    lastSynced = raw; setDirty(0);
  }

  function startSync(user) {
    docRef = db.collection("users").doc(user.uid);
    if (unsub) unsub();
    unsub = docRef.onSnapshot({ includeMetadataChanges: false }, (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      if (!snap.exists) {                                                    // first device: upload what's here
        if (!NOTES_ONLY) { setDirty(dirtyAt || Date.now()); push(); }
        pushNotes(); return;
      }
      const d = snap.data() || {};
      syncNotes(d);
      if (NOTES_ONLY) { setStatus("ok", "Synced."); return; }
      if (typeof d.data !== "string") { setDirty(dirtyAt || Date.now()); push(); return; }   // doc has notes but no tasks yet
      if (d.data === lastSynced) { setStatus("ok", "Synced."); return; }
      if (dirtyAt && dirtyAt > (d.editedAt || 0)) { push(); return; }        // local edits are newer
      let obj; try { obj = JSON.parse(d.data); } catch (e) { return; }
      applyRemote(obj, d.data);
      setStatus("ok", "Synced.");
    }, (e) => setStatus("err", "Sync error: " + (e && e.message ? e.message : e)));
  }

  auth.onAuthStateChanged((user) => {
    if (user) {
      $("fsWho").textContent = user.email || "Signed in";
      hideOverlay();
      setStatus("busy", "Connecting...");
      startSync(user);
    } else {
      docRef = null; if (unsub) { unsub(); unsub = null; }
      setStatus("local", "Signed out - this device only.");
      if (!sessionStorage.getItem(SKIP_KEY)) showOverlay("signin");
    }
  });

  // ---- UI wiring ----
  function friendly(e) {
    const c = (e && e.code) || "";
    if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Email or password doesn't match.";
    if (c.includes("too-many-requests")) return "Too many tries. Wait a minute and try again.";
    if (c.includes("network")) return "No connection. Check your internet.";
    return (e && e.message) || "Sign-in failed.";
  }
  function signIn() {
    const email = $("fsEmail").value.trim(), pass = $("fsPass").value;
    $("fsErr").textContent = "";
    if (!email || !pass) { $("fsErr").textContent = "Enter your email and password."; return; }
    $("fsSignIn").disabled = true; $("fsSignIn").textContent = "Signing in...";
    auth.signInWithEmailAndPassword(email, pass)
      .catch((e) => { $("fsErr").textContent = friendly(e); })
      .finally(() => { $("fsSignIn").disabled = false; $("fsSignIn").textContent = "Sign in"; });
  }
  $("fsSignIn").addEventListener("click", signIn);
  $("fsPass").addEventListener("keydown", (e) => { if (e.key === "Enter") signIn(); });
  $("fsLater").addEventListener("click", () => { sessionStorage.setItem(SKIP_KEY, "1"); hideOverlay(); });
  $("fsClose").addEventListener("click", hideOverlay);
  $("fsSignOut").addEventListener("click", () => {
    if (confirm("Sign out? Your tasks stay on this device but stop syncing.")) { sessionStorage.setItem(SKIP_KEY, "1"); auth.signOut(); hideOverlay(); }
  });
  $("acctBtn").addEventListener("click", () => {
    if (auth.currentUser) { $("fsState").textContent = statusText; showOverlay("account"); }
    else { sessionStorage.removeItem(SKIP_KEY); showOverlay("signin"); }
  });
  window.addEventListener("online", () => { if (dirtyAt && !NOTES_ONLY) push(); pushNotes(); });
})();
