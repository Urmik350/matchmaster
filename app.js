// 1. Firebase setup – REPLACE firebaseConfig with your values from Firebase console
const firebaseConfig = {
  apiKey: "AIzaSyApBo_WBG7JbtYlvh5LV35Tj9NJx5ootXw",
  authDomain: "matchmaster-9e7bb.firebaseapp.com",
  projectId: "matchmaster-9e7bb",
  storageBucket: "matchmaster-9e7bb.firebasestorage.app",
  messagingSenderId: "148755498698",
  appId: "1:148755498698:web:512e3cdcaa09aa346a1633",
  measurementId: "G-KKXWSC97LR"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// App state
let currentUser = null;
let currentWeek = null;

// Helpers
const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

// 2. Simple auth: username + optional PIN
async function login(username, pin) {
  const snap = await db.collection("users").where("username", "==", username).get();
  if (snap.empty) {
    const doc = await db.collection("users").add({
      username,
      pin: pin || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    currentUser = { id: doc.id, username };
  } else {
    const doc = snap.docs[0];
    const data = doc.data();
    if (data.pin && data.pin !== pin) {
      throw new Error("Wrong PIN");
    }
    currentUser = { id: doc.id, username: data.username };
  }
  renderUserInfo();
  loadCurrentWeek();
}

// 3. Week handling
async function loadCurrentWeek() {
  const snap = await db.collection("weeks")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (snap.empty) {
    currentWeek = null;
    qs("#current-week-label").textContent = "No active week yet.";
    qs("#week-status-label").textContent = "No active week.";
    renderPredictMatches([]);
    renderLeaderboard([]);
    return;
  }

  const doc = snap.docs[0];
  currentWeek = { id: doc.id, ...doc.data() };
  qs("#current-week-label").textContent =
    `${currentWeek.displayName} (${currentWeek.competitionName}) – status: ${currentWeek.status}`;
  qs("#week-status-label").textContent =
    `Week: ${currentWeek.displayName} – Status: ${currentWeek.status}`;

  loadMatchesForCurrentWeek();
  loadLeaderboard();
}

async function createWeek(name, competitionId, competitionName) {
  const doc = await db.collection("weeks").add({
    displayName: name,
    competitionId,
    competitionName,
    status: "voting", // start with voting phase
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  currentWeek = { id: doc.id, displayName: name, status: "voting", competitionId, competitionName };
  loadCurrentWeek();
}

async function advanceWeekStatus() {
  if (!currentWeek) return;
  const order = ["voting", "predicting", "locked", "finished"];
  const idx = order.indexOf(currentWeek.status);
  const next = order[(idx + 1) % order.length];
  await db.collection("weeks").doc(currentWeek.id).update({ status: next });
  await loadCurrentWeek();
}

// 4. Import fixtures from our Vercel API
async function importFixturesForWeek(fromDate, toDate) {
  if (!currentWeek) {
    alert("Create a week first.");
    return;
  }
  if (!fromDate || !toDate) {
    alert("Select date range first.");
    return;
  }

  qs("#import-status").textContent = "Importing fixtures...";

  const url = `/api/fixtures?competitionId=${encodeURIComponent(currentWeek.competitionId)}&from=${fromDate}&to=${toDate}`;
  const res = await fetch(url);
  if (!res.ok) {
    qs("#import-status").textContent = "Failed to load fixtures from API.";
    return;
  }

  const data = await res.json();
  const matches = data.matches || [];

  const batch = db.batch();

  matches.forEach(match => {
    const docRef = db.collection("matches").doc();
    batch.set(docRef, {
      weekId: currentWeek.id,
      apiMatchId: match.id,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      kickoff: firebase.firestore.Timestamp.fromDate(new Date(match.utcDate)),
      status: match.status, // "SCHEDULED"
      votes: {},
      selected: false, // voting will decide
      actualHomeGoals: null,
      actualAwayGoals: null,
    });
  });

  await batch.commit();
  qs("#import-status").textContent = `Imported ${matches.length} fixtures.`;
  loadMatchesForCurrentWeek();
}

// 5. Matches & voting
async function loadMatchesForCurrentWeek() {
  if (!currentWeek) {
    renderPredictMatches([]);
    return;
  }
  const snap = await db.collection("matches")
    .where("weekId", "==", currentWeek.id)
    .orderBy("kickoff")
    .get();
  const matches = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderAdminMatches(matches);
  renderPredictMatches(matches);
}

async function toggleVote(matchId, voteYes) {
  if (!currentUser || !currentWeek) return;

  const docRef = db.collection("matches").doc(matchId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const data = snap.data();
    const votes = data.votes || {};
    votes[currentUser.id] = voteYes;
    // majority decision is left to admin or a later step, for now we just store votes
    tx.update(docRef, { votes });
  });

  loadMatchesForCurrentWeek();
}

// 6. Predictions
async function savePrediction(match, homeGoals, awayGoals, usePowerUp) {
  if (!currentWeek || !currentUser) return;

  const now = new Date();
  if (match.kickoff.toDate && now >= match.kickoff.toDate()) {
    alert("Kickoff has passed. You can't predict this match anymore.");
    return;
  }

  // Enforce unique prediction per match
  const dupSnap = await db.collection("predictions")
    .where("matchId", "==", match.id)
    .where("weekId", "==", currentWeek.id)
    .where("homeGoals", "==", homeGoals)
    .where("awayGoals", "==", awayGoals)
    .get();

  if (!dupSnap.empty) {
    alert("Someone already used that exact prediction for this match. Pick a different score.");
    return;
  }

  // Upsert prediction for this user+match
  const existing = await db.collection("predictions")
    .where("matchId", "==", match.id)
    .where("weekId", "==", currentWeek.id)
    .where("userId", "==", currentUser.id)
    .get();

  if (existing.empty) {
    await db.collection("predictions").add({
      weekId: currentWeek.id,
      matchId: match.id,
      userId: currentUser.id,
      homeGoals,
      awayGoals,
      usedPowerUp: usePowerUp ? "double_points" : null,
    });
  } else {
    await db.collection("predictions").doc(existing.docs[0].id).update({
      homeGoals,
      awayGoals,
      usedPowerUp: usePowerUp ? "double_points" : null,
    });
  }
}

// 7. Refresh results from API
async function refreshResultsFromApi() {
  if (!currentWeek) return;
  qs("#calc-status").textContent = "Refreshing scores from API...";

  const snap = await db.collection("matches")
    .where("weekId", "==", currentWeek.id)
    .get();

  const matches = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const m of matches) {
    const res = await fetch(`/api/match?matchId=${encodeURIComponent(m.apiMatchId)}`);
    if (!res.ok) continue;
    const data = await res.json();

    const update = {
      status: data.status,
    };

    if (data.status === "FINISHED" && data.score && data.score.fullTime) {
      update.actualHomeGoals = data.score.fullTime.home;
      update.actualAwayGoals = data.score.fullTime.away;
    }

    await db.collection("matches").doc(m.id).update(update);
  }

  qs("#calc-status").textContent = "Scores refreshed from API.";
  loadMatchesForCurrentWeek();
}

// 8. Scoring & leaderboard
function distance(pred, actual) {
  return Math.abs(pred.homeGoals - actual.homeGoals) +
         Math.abs(pred.awayGoals - actual.awayGoals);
}

async function calculateScoresForWeek() {
  if (!currentWeek) return;
  qs("#calc-status").textContent = "Calculating scores...";

  const [matchesSnap, predsSnap, usersSnap] = await Promise.all([
    db.collection("matches").where("weekId", "==", currentWeek.id).get(),
    db.collection("predictions").where("weekId", "==", currentWeek.id).get(),
    db.collection("users").get(),
  ]);

  const matches = matchesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(m => m.actualHomeGoals != null && m.actualAwayGoals != null);

  const preds = predsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const users = Object.fromEntries(
    usersSnap.docs.map(d => [d.id, d.data().username])
  );

  const scores = {}; // userId -> pointsThisWeek
  preds.forEach(p => { scores[p.userId] = 0; });

  for (const match of matches) {
    const mPreds = preds.filter(p => p.matchId === match.id);
    if (!mPreds.length) continue;

    const withDist = mPreds.map(p => ({
      ...p,
      dist: distance(
        { homeGoals: p.homeGoals, awayGoals: p.awayGoals },
        { homeGoals: match.actualHomeGoals, awayGoals: match.actualAwayGoals }
      ),
    }));

    const minDist = Math.min(...withDist.map(p => p.dist));

    for (const p of withDist) {
      let basePoints = 0;
      if (p.dist === 0) basePoints = 3;
      else if (p.dist === minDist) basePoints = 1;

      if (p.usedPowerUp === "double_points" && basePoints > 0) {
        basePoints *= 2;
      }

      scores[p.userId] = (scores[p.userId] || 0) + basePoints;
    }
  }

  const batch = db.batch();

  for (const [userId, pts] of Object.entries(scores)) {
    const docRef = db.collection("scores").doc(`${currentWeek.id}_${userId}`);
    batch.set(docRef, {
      weekId: currentWeek.id,
      userId,
      pointsThisWeek: pts,
    }, { merge: true });
  }

  await batch.commit();
  qs("#calc-status").textContent = "Scores updated!";
  loadLeaderboard();
}

async function loadLeaderboard() {
  if (!currentWeek) {
    renderLeaderboard([]);
    return;
  }

  const [weekScoresSnap, allScoresSnap, usersSnap] = await Promise.all([
    db.collection("scores").where("weekId", "==", currentWeek.id).get(),
    db.collection("scores").get(),
    db.collection("users").get(),
  ]);

  const users = Object.fromEntries(
    usersSnap.docs.map(d => [d.id, d.data().username])
  );

  const weekScores = {};
  weekScoresSnap.docs.forEach(d => {
    const data = d.data();
    weekScores[data.userId] = data.pointsThisWeek;
  });

  const totalScores = {};
  allScoresSnap.docs.forEach(d => {
    const data = d.data();
    totalScores[data.userId] = (totalScores[data.userId] || 0) + data.pointsThisWeek;
  });

  const rows = Object.keys(users).map(userId => ({
    userId,
    username: users[userId],
    week: weekScores[userId] || 0,
    total: totalScores[userId] || 0,
  })).sort((a, b) => b.total - a.total);

  renderLeaderboard(rows);
}

// 9. Rendering
function renderUserInfo() {
  const el = qs("#user-info");
  if (!currentUser) {
    el.textContent = "";
    return;
  }
  el.textContent = `Logged in as ${currentUser.username}`;
}

function renderAdminMatches(matches) {
  const ul = qs("#admin-matches-list");
  ul.innerHTML = "";
  matches.forEach(m => {
    const li = document.createElement("li");
    const votes = m.votes || {};
    const yesVotes = Object.values(votes).filter(v => v === true).length;
    const noVotes = Object.values(votes).filter(v => v === false).length;

    li.innerHTML = `
      <strong>${m.homeTeam} vs ${m.awayTeam}</strong>
      <br/>
      Kickoff: ${m.kickoff.toDate ? m.kickoff.toDate().toLocaleString() : ""}
      <br/>
      Votes: ✅ ${yesVotes} | ❌ ${noVotes}
      <br/>
      Included: ${m.selected ? "Yes" : "No"}
    `;
    ul.appendChild(li);
  });
}

function renderPredictMatches(matches) {
  const ul = qs("#predict-matches-list");
  ul.innerHTML = "";

  if (!currentUser || !currentWeek) return;

  matches.filter(m => m.selected).forEach(m => {
    const li = document.createElement("li");
    const label = document.createElement("div");
    label.innerHTML = `<strong>${m.homeTeam} vs ${m.awayTeam}</strong><br/>Kickoff: ${m.kickoff.toDate ? m.kickoff.toDate().toLocaleString() : ""}`;

    const inputHome = document.createElement("input");
    inputHome.type = "number";
    inputHome.min = 0;
    inputHome.placeholder = "Home goals";

    const inputAway = document.createElement("input");
    inputAway.type = "number";
    inputAway.min = 0;
    inputAway.placeholder = "Away goals";

    const powerUpCheck = document.createElement("input");
    powerUpCheck.type = "checkbox";
    const powerUpLabel = document.createElement("label");
    powerUpLabel.textContent = " Use double points";
    powerUpLabel.prepend(powerUpCheck);

    const voteYesBtn = document.createElement("button");
    voteYesBtn.textContent = "Vote include";
    voteYesBtn.addEventListener("click", () => toggleVote(m.id, true));

    const voteNoBtn = document.createElement("button");
    voteNoBtn.textContent = "Vote skip";
    voteNoBtn.addEventListener("click", () => toggleVote(m.id, false));

    const btn = document.createElement("button");
    btn.textContent = "Save prediction";

    btn.addEventListener("click", () => {
      const hg = parseInt(inputHome.value, 10);
      const ag = parseInt(inputAway.value, 10);
      if (Number.isNaN(hg) || Number.isNaN(ag)) {
        alert("Enter valid numbers");
        return;
      }
      savePrediction(m, hg, ag, powerUpCheck.checked);
    });

    li.appendChild(label);
    li.appendChild(inputHome);
    li.appendChild(inputAway);
    li.appendChild(powerUpLabel);
    li.appendChild(btn);
    li.appendChild(document.createElement("br"));
    li.appendChild(voteYesBtn);
    li.appendChild(voteNoBtn);

    ul.appendChild(li);
  });
}

function renderLeaderboard(rows) {
  const tbody = qs("#leaderboard-body");
  tbody.innerHTML = "";
  rows.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.username}</td>
      <td>${r.week}</td>
      <td>${r.total}</td>
    `;
    tbody.appendChild(tr);
  });
}

// 10. Wire up UI
document.addEventListener("DOMContentLoaded", () => {
  const authSection = qs("#auth-section");
  const appSection = qs("#app-section");

  qs("#login-btn").addEventListener("click", async () => {
    const username = qs("#username-input").value.trim();
    const pin = qs("#pin-input").value.trim();
    qs("#auth-error").textContent = "";
    if (!username) {
      qs("#auth-error").textContent = "Enter a username";
      return;
    }
    try {
      await login(username, pin);
      hide(authSection);
      show(appSection);
    } catch (e) {
      qs("#auth-error").textContent = e.message;
    }
  });

  // Tabs
  qsa(".tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      qsa(".tabs button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const tabId = btn.dataset.tab;
      qsa(".tab").forEach(tab => tab.classList.add("hidden"));
      qs("#" + tabId).classList.remove("hidden");
    });
  });

  // Default tab
  const firstTabBtn = qs(".tabs button");
  if (firstTabBtn) firstTabBtn.click();

  // Admin actions
  qs("#create-week-btn").addEventListener("click", () => {
    const name = qs("#week-name-input").value.trim();
    const compSelect = qs("#competition-select");
    const competitionId = compSelect.value;
    const competitionName = compSelect.options[compSelect.selectedIndex].text;
    if (!name) return;
    createWeek(name, competitionId, competitionName);
  });

  qs("#advance-status-btn").addEventListener("click", () => {
    advanceWeekStatus();
  });

  qs("#import-fixtures-btn").addEventListener("click", () => {
    const from = qs("#from-date-input").value;
    const to = qs("#to-date-input").value;
    importFixturesForWeek(from, to);
  });

  qs("#refresh-results-btn").addEventListener("click", () => {
    refreshResultsFromApi();
  });

  qs("#calculate-scores-btn").addEventListener("click", () => {
    calculateScoresForWeek();
  });
});
