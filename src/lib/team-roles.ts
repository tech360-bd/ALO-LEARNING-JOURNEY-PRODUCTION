export const ROLES = [
  'super_admin',
  'company_owner',
  'admin',
  'manager',
  'social_media_manager',
  'content_manager',
  'seo_manager',
  'ai_agent_manager',
  'customer_support',
  'team_member',
  'client_user',
  'viewer',
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  company_owner: 'Company Owner',
  admin: 'Admin',
  manager: 'Manager',
  social_media_manager: 'Social Media Manager',
  content_manager: 'Content Manager',
  seo_manager: 'SEO Manager',
  ai_agent_manager: 'AI Agent Manager',
  customer_support: 'Customer Support',
  team_member: 'Team Member',
  client_user: 'Client User',
  viewer: 'Viewer',
};

// Platform administration and company ownership are not delegated by tenant APIs.
export function canManageTeam(role: unknown): boolean {
  return role === 'admin' || role === 'company_owner' || role === 'super_admin';
}

export function canAssignTeamRole(actor: unknown, role: unknown): boolean {
  return canManageTeam(actor) && ROLES.some(key => key === role) &&
    role !== 'super_admin' && role !== 'company_owner' && !(actor === 'admin' && role === 'admin');
}

// Earlier dashboards sent display labels; accept only exact known labels/keys.
export function teamRoleKey(value: unknown): string | undefined {
  return ROLES.find(key => value === key || value === ROLE_LABELS[key]);
}
