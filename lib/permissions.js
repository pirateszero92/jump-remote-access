const ROLES = Object.freeze({
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  USER: 'user',
});

const ROLE_RANK = {
  [ROLES.USER]: 1,
  [ROLES.ADMIN]: 2,
  [ROLES.SUPERADMIN]: 3,
};

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === ROLES.SUPERADMIN || value === ROLES.ADMIN || value === ROLES.USER) {
    return value;
  }

  return null;
}

function canViewReports(user) {
  return user?.role === ROLES.SUPERADMIN;
}

function canManageUsers(actor) {
  return actor?.role === ROLES.SUPERADMIN || actor?.role === ROLES.ADMIN;
}

function canManageTarget(actor) {
  return actor?.role === ROLES.SUPERADMIN || actor?.role === ROLES.ADMIN;
}

function canAssignTargets(actor) {
  return actor?.role === ROLES.SUPERADMIN || actor?.role === ROLES.ADMIN;
}

function canCreateSession(actor) {
  return Boolean(actor?.role);
}

function actorCanManageUser(actor, targetUser) {
  if (!canManageUsers(actor) || !targetUser) {
    return false;
  }

  if (actor.role === ROLES.SUPERADMIN) {
    return true;
  }

  if (actor.role === ROLES.ADMIN) {
    return targetUser.id === actor.id || targetUser.role === ROLES.USER;
  }

  return false;
}

function actorCanAssignRole(actor, role) {
  const nextRole = normalizeRole(role);
  if (!nextRole) {
    return false;
  }

  if (actor.role === ROLES.SUPERADMIN) {
    return true;
  }

  if (actor.role === ROLES.ADMIN) {
    return nextRole === ROLES.USER;
  }

  return false;
}

function filterTargetsForUser(targets, user) {
  if (!user) {
    return [];
  }

  if (user.role === ROLES.SUPERADMIN || user.role === ROLES.ADMIN) {
    return targets;
  }

  const allowed = new Set(user.assignedTargetIds || []);
  return targets.filter((target) => allowed.has(target.id));
}

function userCanAccessTarget(user, target) {
  if (!user || !target) {
    return false;
  }

  if (user.role === ROLES.SUPERADMIN || user.role === ROLES.ADMIN) {
    return true;
  }

  return (user.assignedTargetIds || []).includes(target.id);
}

function findTargetForSession(targets, { targetId, ip, port, proto }) {
  if (targetId) {
    return targets.find((entry) => entry.id === targetId) || null;
  }

  const normalizedProto = String(proto || 'VNC').toUpperCase();
  const host = String(ip || '').trim();
  const sessionPort = Number.parseInt(String(port || ''), 10);

  return targets.find((entry) => {
    if (String(entry.ip).trim() !== host) {
      return false;
    }

    if (String(entry.proto || 'VNC').toUpperCase() !== normalizedProto) {
      return false;
    }

    return Number.parseInt(String(entry.port), 10) === sessionPort;
  }) || null;
}

module.exports = {
  ROLES,
  ROLE_RANK,
  normalizeRole,
  canViewReports,
  canManageUsers,
  canManageTarget,
  canAssignTargets,
  canCreateSession,
  actorCanManageUser,
  actorCanAssignRole,
  filterTargetsForUser,
  userCanAccessTarget,
  findTargetForSession,
};
