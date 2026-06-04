(function bootstrap() {
  const form = document.getElementById('user-form');
  const formTitle = document.getElementById('form-title');
  const formMsg = document.getElementById('form-msg');
  const roleHint = document.getElementById('role-hint');
  const editUserId = document.getElementById('edit-user-id');
  const usernameInput = document.getElementById('user-username');
  const displayNameInput = document.getElementById('user-display-name');
  const passwordInput = document.getElementById('user-password');
  const roleSelect = document.getElementById('user-role');
  const assignWrap = document.getElementById('assign-wrap');
  const assignListEl = document.getElementById('target-assign-list');
  const userTableBody = document.getElementById('user-table-body');
  const cancelEditBtn = document.getElementById('btn-cancel-edit');

  // Current user card elements
  const cuAvatar = document.getElementById('cu-avatar');
  const cuName = document.getElementById('cu-name');
  const cuUsername = document.getElementById('cu-username');
  const cuRoleBadge = document.getElementById('cu-role-badge');
  const topbarChip = document.getElementById('topbar-user-chip');
  const btnResetOwn = document.getElementById('btn-reset-own-password');

  // Reset password modal elements
  const rpModal = document.getElementById('rp-modal');
  const rpTitle = document.getElementById('rp-title');
  const rpSub = document.getElementById('rp-sub');
  const rpPassword = document.getElementById('rp-password');
  const rpConfirm = document.getElementById('rp-confirm');
  const rpMsg = document.getElementById('rp-msg');
  const rpCancelBtn = document.getElementById('rp-cancel');
  const rpConfirmBtn = document.getElementById('rp-confirm-btn');
  const rpToggle = document.getElementById('rp-toggle');
  const rpConfirmToggle = document.getElementById('rp-confirm-toggle');

  let me = null;
  let targets = [];
  let users = [];
  let rpTargetUserId = null;

  // ── API helper ──────────────────────────────────────────
  async function api(method, path, body) {
    const options = {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    };

    const response = await fetch(path, options);
    if (response.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }

    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    return payload;
  }

  // ── Helpers ─────────────────────────────────────────────
  function setFormMessage(message, isError = false) {
    formMsg.textContent = message || '';
    formMsg.classList.toggle('err', Boolean(isError));
  }

  function setRpMessage(message, isError = false) {
    rpMsg.textContent = message || '';
    rpMsg.classList.toggle('err', Boolean(isError));
  }

  function allowedRolesForCreate() {
    if (me.role === 'superadmin') return ['superadmin', 'admin', 'user'];
    return ['user'];
  }

  function fillRoleOptions(selected) {
    roleSelect.innerHTML = '';
    allowedRolesForCreate().forEach((role) => {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = role;
      if (role === selected) option.selected = true;
      roleSelect.appendChild(option);
    });
  }

  function renderTargetAssign(selectedIds = []) {
    const selected = new Set(selectedIds);
    assignListEl.innerHTML = '';

    if (!targets.length) {
      assignListEl.innerHTML = '<p class="admin-msg">No targets defined yet.</p>';
      return;
    }

    targets.forEach((target) => {
      const label = document.createElement('label');
      label.className = 'target-assign-item';
      label.innerHTML = `
        <input type="checkbox" value="${target.id}" ${selected.has(target.id) ? 'checked' : ''}>
        <span>${target.name} · ${target.proto} ${target.ip}:${target.port}</span>
      `;
      assignListEl.appendChild(label);
    });
  }

  function getSelectedTargetIds() {
    return Array.from(assignListEl.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
  }

  function toggleAssignVisibility() {
    const show = roleSelect.value === 'user';
    assignWrap.style.display = show ? '' : 'none';
  }

  function resetForm() {
    editUserId.value = '';
    usernameInput.disabled = false;
    usernameInput.value = '';
    displayNameInput.value = '';
    passwordInput.value = '';
    passwordInput.placeholder = '';
    fillRoleOptions('user');
    toggleAssignVisibility();
    renderTargetAssign([]);
    formTitle.textContent = 'Add user';
    cancelEditBtn.hidden = true;
    setFormMessage('');
  }

  function startEdit(user) {
    editUserId.value = user.id;
    usernameInput.value = user.username;
    usernameInput.disabled = true;
    displayNameInput.value = user.displayName || user.username;
    passwordInput.value = '';
    passwordInput.placeholder = 'Leave blank to keep current password';

    fillRoleOptions(user.role);
    if (!allowedRolesForCreate().includes(user.role)) {
      const option = document.createElement('option');
      option.value = user.role;
      option.textContent = user.role;
      option.selected = true;
      roleSelect.appendChild(option);
    }

    renderTargetAssign(user.assignedTargetIds || []);
    toggleAssignVisibility();
    formTitle.textContent = `Edit: ${user.username}`;
    cancelEditBtn.hidden = false;
    setFormMessage('');
  }

  // ── Current user card ────────────────────────────────────
  function renderCurrentUser() {
    if (!me) return;

    const display = me.displayName || me.username;
    const initial = display.charAt(0).toUpperCase();

    // Topbar chip
    if (topbarChip) {
      topbarChip.textContent = `${display} (${me.role})`;
    }

    // Card
    if (cuAvatar) cuAvatar.textContent = initial;
    if (cuName) cuName.textContent = display;
    if (cuUsername) cuUsername.textContent = `@${me.username}`;
    if (cuRoleBadge) {
      cuRoleBadge.textContent = me.role;
      cuRoleBadge.className = `role-badge ${me.role}`;
    }
  }

  // ── Reset password modal ─────────────────────────────────
  function openResetModal(userId, label) {
    rpTargetUserId = userId;
    rpTitle.textContent = 'Reset Password';
    rpSub.textContent = `กำหนดรหัสผ่านใหม่สำหรับ: ${label}`;
    rpPassword.value = '';
    rpConfirm.value = '';
    setRpMessage('');
    rpModal.classList.add('open');
    rpPassword.focus();
  }

  function closeResetModal() {
    rpModal.classList.remove('open');
    rpTargetUserId = null;
    rpPassword.value = '';
    rpConfirm.value = '';
    setRpMessage('');
  }

  function togglePasswordVis(input, btn) {
    const isText = input.type === 'text';
    input.type = isText ? 'password' : 'text';
    btn.querySelector('i').className = isText ? 'fa-regular fa-eye' : 'fa-regular fa-eye-slash';
  }

  rpToggle?.addEventListener('click', () => togglePasswordVis(rpPassword, rpToggle));
  rpConfirmToggle?.addEventListener('click', () => togglePasswordVis(rpConfirm, rpConfirmToggle));
  rpCancelBtn?.addEventListener('click', closeResetModal);
  rpModal?.addEventListener('click', (e) => { if (e.target === rpModal) closeResetModal(); });

  rpConfirmBtn?.addEventListener('click', async () => {
    const newPass = rpPassword.value;
    const confirm = rpConfirm.value;

    if (!newPass || newPass.length < 6) {
      setRpMessage('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร', true);
      return;
    }

    if (newPass !== confirm) {
      setRpMessage('รหัสผ่านไม่ตรงกัน', true);
      return;
    }

    rpConfirmBtn.disabled = true;
    rpConfirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...';

    try {
      await api('PUT', `/api/users/${encodeURIComponent(rpTargetUserId)}`, { password: newPass });
      closeResetModal();
      setFormMessage('Reset password สำเร็จ ✓');
    } catch (error) {
      setRpMessage(error.message, true);
    } finally {
      rpConfirmBtn.disabled = false;
      rpConfirmBtn.innerHTML = '<i class="fa-solid fa-check"></i> ยืนยัน';
    }
  });

  // ── Users table ──────────────────────────────────────────
  function renderUsersTable() {
    userTableBody.innerHTML = '';

    users.forEach((user) => {
      const isMe = user.id === me.id;
      const canEdit = me.role === 'superadmin'
        || (me.role === 'admin' && user.role === 'user' && !isMe);
      const canDelete = canEdit && !isMe;
      const canResetPass = canEdit || isMe;

      const row = document.createElement('tr');
      if (isMe) row.classList.add('current-user-row');

      row.innerHTML = `
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="cu-mini-avatar">${(user.displayName || user.username).charAt(0).toUpperCase()}</div>
            <div>
              <strong>${user.displayName || user.username}</strong>
              ${isMe ? '<span class="you-badge">YOU</span>' : ''}
              <br>
              <span style="color:var(--text3);font-size:10px">@${user.username}</span>
            </div>
          </div>
        </td>
        <td><span class="role-badge ${user.role}">${user.role}</span></td>
        <td>${user.role === 'user' ? (user.assignedTargetIds?.length || 0) : '—'}</td>
        <td>
          <div class="admin-actions">
            ${canEdit ? '<button type="button" class="vt-btn btn-edit">Edit</button>' : ''}
            ${canResetPass ? '<button type="button" class="vt-btn btn-reset-pass"><i class="fa-solid fa-key"></i> Reset PW</button>' : ''}
            ${canDelete ? '<button type="button" class="vt-btn btn-delete" style="color:var(--red)">Delete</button>' : ''}
          </div>
        </td>
      `;

      row.querySelector('.btn-edit')?.addEventListener('click', () => startEdit(user));
      row.querySelector('.btn-reset-pass')?.addEventListener('click', () => {
        openResetModal(user.id, user.displayName || user.username);
      });
      row.querySelector('.btn-delete')?.addEventListener('click', async () => {
        if (!window.confirm(`Delete user ${user.username}?`)) return;
        try {
          await api('DELETE', `/api/users/${encodeURIComponent(user.id)}`);
          await refresh();
          setFormMessage(`Deleted ${user.username}`);
        } catch (error) {
          setFormMessage(error.message, true);
        }
      });

      userTableBody.appendChild(row);
    });
  }

  // ── Refresh ──────────────────────────────────────────────
  async function refresh() {
    [me, users, targets] = await Promise.all([
      api('GET', '/api/me'),
      api('GET', '/api/users'),
      api('GET', '/api/targets'),
    ]);

    if (!['superadmin', 'admin'].includes(me.role)) {
      window.location.href = '/';
      return;
    }

    roleHint.textContent = me.role === 'superadmin'
      ? 'Superadmin: จัดการทุก role และดู Reports ได้'
      : 'Admin: จัดการ user role เท่านั้น (ไม่เข้า Reports)';

    renderCurrentUser();
    renderUsersTable();

    if (!editUserId.value) {
      renderTargetAssign([]);
    }
  }

  // ── "Reset My Password" button ───────────────────────────
  btnResetOwn?.addEventListener('click', () => {
    if (!me) return;
    openResetModal(me.id, me.displayName || me.username);
  });

  // ── Form submit ──────────────────────────────────────────
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormMessage('');

    const body = {
      username: usernameInput.value.trim(),
      displayName: displayNameInput.value.trim(),
      role: roleSelect.value,
      assignedTargetIds: getSelectedTargetIds(),
    };

    if (passwordInput.value) {
      body.password = passwordInput.value;
    }

    try {
      if (editUserId.value) {
        await api('PUT', `/api/users/${encodeURIComponent(editUserId.value)}`, body);
        setFormMessage('User updated ✓');
      } else {
        if (!body.password) throw new Error('Password is required for new users');
        await api('POST', '/api/users', body);
        setFormMessage('User created ✓');
      }

      resetForm();
      await refresh();
    } catch (error) {
      setFormMessage(error.message, true);
    }
  });

  roleSelect.addEventListener('change', toggleAssignVisibility);
  cancelEditBtn.addEventListener('click', resetForm);

  window.handleLogout = async function handleLogout() {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = '/login.html';
    }
  };

  refresh().then(() => {
    resetForm();
  }).catch((error) => {
    setFormMessage(error.message, true);
  });
})();

