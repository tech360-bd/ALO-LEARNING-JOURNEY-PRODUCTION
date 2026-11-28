export type ViewId =
  | 'dashboard'
  | 'workforce'
  | 'integrations'
  | 'social-accounts'
  | 'ai-command'
  | 'media-studio'
  | 'crm'
  | 'seo'
  | 'campaigns'
  | 'content'
  | 'analytics'
  | 'team'
  | 'messages'
  | 'announcements'
  | 'audit-logs'
  | 'ai-agents'
  | 'ai-models'
  | 'subscriptions'
  | 'settings'
  | 'voice-agents'
  | 'calls'
  | 'voice-studio'
  | 'contact-center'
  | 'billing-voice'
  | 'students'
  | 'employees'
  | 'departments'
  | 'programs'
  | 'attendance'
  | 'assignments'
  | 'exams'
  | 'schedule'
  | 'finance'
  | 'fees'
  | 'salary'
  | 'hrm'
  | 'leave'
  | 'partners';

export interface DashboardActivityItem {
  id: string;
  type: string;
  description: string;
  createdAt: string;
  message?: string;
  time?: string;
  platform?: string;
}

// Dashboard stats shape — returned by GET /api/dashboard
export interface DashboardStats {
  totalLeads: number;
  totalContacts: number;
  totalDeals: number;
  totalCampaigns: number;
  totalContents: number;
  totalAgents: number;
  activeAgents?: number;
  activeIntegrations: number;
  totalSmsSent: number;
  totalSocialAccounts: number;
  recentLeads: Array<{
    id: string;
    name: string;
    email: string | null;
    status: string;
    score: number;
    source: string;
    createdAt: string;
  }>;
  pipelineValue: number;
  monthlyRevenue: number;
  aiAgentRuns: number;
  // Social stats
  totalFollowers: number;
  followerGrowth: number;
  totalEngagement: number;
  engagementGrowth: number;
  totalReach: number;
  reachGrowth: number;
  totalMessages: number;
  messageGrowth: number;
  leadGrowth: number;
  scheduledPosts: number;
  activeCampaigns: number;
  connectedPlatforms: number;
  totalPlatforms?: number;
  platformStats: Array<{ platform: string; followers: number; engagement: number }>;
  weeklyData: Array<{ day: string; leads: number; engagement: number; reach: number }>;
  recentActivity: DashboardActivityItem[];
}
