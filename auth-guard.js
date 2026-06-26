/* ================================================================
   AUTH-GUARD.JS — Role-Based Access Control (RBAC)
   Smart Greenhouse Monitoring — PT Kembang Turi
   ================================================================

   CARA PAKAI: Sisipkan tag ini di SETIAP halaman (kecuali index.html),
   tepat SEBELUM </body>:

     <script src="auth-guard.js"></script>

   Untuk index.html (halaman login), panggil setelah Firebase Auth
   berhasil dan role sudah didapat dari Realtime Database:
     AuthGuard.login(nama, role);  // role dari /users/{uid}/role
     window.location.replace(AuthGuard.ROLES[role].defaultPage);

   ================================================================ */

const AuthGuard = (() => {

  /* ──────────────────────────────────────────────────────────────
     1. ROLE DEFINITIONS
     Tentukan: halaman yang boleh diakses & landing page default
     Role keys HARUS sama persis dengan value `role` yang disimpan
     di Firebase Realtime Database (/users/{uid}/role).
  ────────────────────────────────────────────────────────────── */
  const ROLES = {
    'admin': {
      allowedPages: ['status.html', 'akun.html'],
      defaultPage:  'status.html',
      label:        'Admin IT',
      avatarInitial:'A',
      avatarColor:  '#6366F1',   // 🟣 Indigo (sesuai spec)
    },
    'manajer': {
      allowedPages: ['dashboard.html', 'laporan.html', 'parameter.html', 'status.html'],
      defaultPage:  'dashboard.html',
      label:        'Manajer',
      avatarInitial:'M',
      avatarColor:  '#F59E0B',   // 🟠 Amber (sesuai spec)
    },
    'asisten': {
      allowedPages: ['dashboard.html', 'laporan.html', 'parameter.html'],
      defaultPage:  'dashboard.html',
      label:        'Asisten Kebun',
      avatarInitial:'A',
      avatarColor:  '#3B82F6',   // 🔵 Biru (sesuai spec)
    },
    'pekerja': {
      allowedPages: ['dashboard.html'],
      defaultPage:  'dashboard.html',
      label:        'Pekerja Lahan',
      avatarInitial:'P',
      avatarColor:  '#22C55E',   // 🟢 Hijau (sesuai spec)
    },
  };

  /* ──────────────────────────────────────────────────────────────
     2. MENU CONFIG
     Mapping: href filename → role keys yang BOLEH melihat menu ini
     (diturunkan otomatis dari ROLES.allowedPages, supaya selalu sinkron)
  ────────────────────────────────────────────────────────────── */
  const MENU_ACCESS = {};
  Object.entries(ROLES).forEach(([roleKey, cfg]) => {
    cfg.allowedPages.forEach(page => {
      if (!MENU_ACCESS[page]) MENU_ACCESS[page] = [];
      MENU_ACCESS[page].push(roleKey);
    });
  });

  /* ──────────────────────────────────────────────────────────────
     3. SESSION HELPERS
     Simpan/baca session di localStorage agar survive refresh
  ────────────────────────────────────────────────────────────── */
  const SESSION_KEY = 'kt_session';

  function saveSession(nama, role) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      nama,
      role,
      loginAt: Date.now(),
    }));
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    // Also clear old sessionStorage format if exists
    sessionStorage.removeItem('kt_user');
  }

  /* ──────────────────────────────────────────────────────────────
     4. GET CURRENT PAGE FILENAME
  ────────────────────────────────────────────────────────────── */
  function getCurrentPage() {
    const path = window.location.pathname;
    // e.g. "/project/dashboard.html" → "dashboard.html"
    return path.split('/').pop() || 'index.html';
  }

  /* ──────────────────────────────────────────────────────────────
     5. REDIRECT HELPER
  ────────────────────────────────────────────────────────────── */
  function redirectTo(page) {
    // Prevent redirect loops
    if (getCurrentPage() !== page) {
      window.location.replace(page);
    }
  }

  /* ──────────────────────────────────────────────────────────────
     6. GATE CHECK — Call this on every protected page
     Jika tidak login → tendang ke index.html
     Jika login tapi tidak punya akses → tendang ke defaultPage
  ────────────────────────────────────────────────────────────── */
  function gate() {
    const session = getSession();

    // Not logged in → back to login
    if (!session || !session.role) {
      redirectTo('index.html');
      return false;
    }

    const roleCfg = ROLES[session.role];

    // Unknown role → back to login
    if (!roleCfg) {
      clearSession();
      redirectTo('index.html');
      return false;
    }

    const currentPage = getCurrentPage();

    // Page not in allowed list → redirect to default page for this role
    if (!roleCfg.allowedPages.includes(currentPage)) {
      redirectTo(roleCfg.defaultPage);
      return false;
    }

    // Access granted — run UI updates
    _applyUI(session, roleCfg);
    return true;
  }

  /* ──────────────────────────────────────────────────────────────
     7. APPLY UI — Hide/show menu items & update profile display
  ────────────────────────────────────────────────────────────── */
  function _applyUI(session, roleCfg) {
    // A. Hide/show sidebar links (.sb-link)
    document.querySelectorAll('.sb-link[href]').forEach(link => {
      const page = link.getAttribute('href').split('/').pop();
      const allowed = MENU_ACCESS[page];
      if (!allowed) return;
      // Use visibility trick to keep layout stable
      link.style.display = allowed.includes(session.role) ? '' : 'none';
    });

    // B. Hide/show sidebar group labels
    //    If all links in a group are hidden, hide the label too
    document.querySelectorAll('.sb-nav-group-label').forEach(label => {
      // Find all .sb-link siblings that come after this label
      // until the next label or end of parent
      let sibling = label.nextElementSibling;
      let hasVisible = false;
      while (sibling && !sibling.classList.contains('sb-nav-group-label')) {
        if (sibling.classList.contains('sb-link') && sibling.style.display !== 'none') {
          hasVisible = true;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      label.style.display = hasVisible ? '' : 'none';
    });

    // C. Hide/show bottom nav items (.nav-item)
    document.querySelectorAll('.nav-item[href]').forEach(item => {
      const page = item.getAttribute('href').split('/').pop();
      const allowed = MENU_ACCESS[page];
      if (!allowed) return;
      item.style.display = allowed.includes(session.role) ? '' : 'none';
    });

    // D. Hide the role-switcher dropdown (no longer needed with real RBAC)
    const roleSection = document.querySelector('.sb-role-section');
    if (roleSection) roleSection.style.display = 'none';

    // E. Update profile chip — name + avatar
    //    Targets common IDs used across your pages
    _setTextIfExists('profileName', session.nama || roleCfg.label);
    _setTextIfExists('greetName',   session.nama || roleCfg.label);

    // Avatar initial
    // Selector mencakup SEMUA variasi class/id avatar di seluruh halaman:
    //   #avatarEl   → dashboard.html (id unik)
    //   .avatar     → dashboard.html (class)
    //   .avatar-sm  → laporan.html, parameter.html, status.html
    //   .avatar-chip→ akun.html
    const avatarEls = document.querySelectorAll(
      '#avatarEl, .avatar, .avatar-sm, .avatar-chip'
    );
    avatarEls.forEach(el => {
      el.textContent = (session.nama || roleCfg.label).charAt(0).toUpperCase();
      if (roleCfg.avatarColor) el.style.background = roleCfg.avatarColor;
    });

    // F. Update page greeting if exists
    const greeting = document.querySelector('.page-greeting');
    if (greeting) {
      greeting.innerHTML = `Halo, <strong>${session.nama || roleCfg.label}</strong> 👋`;
    }

    // G. Wire up logout button
    document.querySelectorAll('.sb-logout, [data-action="logout"]').forEach(btn => {
      btn.onclick = () => logout();
    });

    console.log(`[AuthGuard] ✓ ${session.role} (${session.nama}) → ${getCurrentPage()}`);
  }

  function _setTextIfExists(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  /* ──────────────────────────────────────────────────────────────
     8. LOGIN — Call this from index.html after Firebase Auth +
     role lookup berhasil
  ────────────────────────────────────────────────────────────── */
  function login(nama, role) {
    if (!ROLES[role]) {
      console.error('[AuthGuard] Unknown role:', role);
      return false;
    }
    saveSession(nama, role);
    return true;
  }

  /* ──────────────────────────────────────────────────────────────
     9. LOGOUT — Clear session and go to login
  ────────────────────────────────────────────────────────────── */
  function logout() {
    clearSession();
    // Sign out dari Firebase Auth juga, jika bridge tersedia
    if (window.FB && typeof window.FB.signOutUser === 'function') {
      window.FB.signOutUser().catch(() => {});
    }
    window.location.replace('index.html');
  }

  /* ──────────────────────────────────────────────────────────────
     10. GET SESSION — For reading current user anywhere
  ────────────────────────────────────────────────────────────── */
  function getUser() {
    return getSession();
  }

  /* ──────────────────────────────────────────────────────────────
     11. AUTO-INIT
     When DOM is ready, auto-run gate() on protected pages.
     index.html is skipped (it's the login page).
  ────────────────────────────────────────────────────────────── */
  const PROTECTED_PAGES = [
    'dashboard.html', 'laporan.html', 'parameter.html',
    'status.html', 'akun.html'
  ];

  function _autoInit() {
    const page = getCurrentPage();
    if (PROTECTED_PAGES.includes(page)) {
      // Hide body immediately to prevent flash of unauthorized content
      document.body.style.visibility = 'hidden';
      gate();
      // Reveal body only after gate passes
      document.body.style.visibility = '';
    }
  }

  // Run after DOM is parsed
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

  /* ── Public API ── */
  return { login, logout, gate, getUser, ROLES };

})();
