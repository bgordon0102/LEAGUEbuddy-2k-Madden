import fs from 'fs';
import path from 'path';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
export const STAFF_ROLE_NAMES = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];

export function loadRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function hasStaffRole(member, roleMap = null) {
  const map = roleMap || loadRoleMap();
  const ids = STAFF_ROLE_NAMES.map(name => map[name]).filter(Boolean);
  if (ids.length && member?.roles?.cache) {
    return ids.some(id => member.roles.cache.has(id));
  }
  return member?.roles?.cache?.some(r => STAFF_ROLE_NAMES.includes(r.name)) ?? false;
}
