'use client';

// ════════════════════════════════════════════════════════════
// AI SALES INTELLIGENCE — MODULE ROOT (v2.27.0)
// هوش مصنوعی فروش و تحلیل مکالمات
// Route keys: ai-dashboard | ai-calls | ai-actions | ai-coaching |
//             ai-playbook | ai-settings
// ════════════════════════════════════════════════════════════

import React from 'react';
import { Brain } from 'lucide-react';
import { useTabAccess } from '@/components/access-context';
import { AiDashboard } from './ai-dashboard';
import { AiCalls } from './ai-calls';
import { AiActions } from './ai-actions';
import { AiCoaching } from './ai-coaching';
import { AiPlaybook } from './ai-playbook';
import { AiSettings } from './ai-settings';
import type { CompanySlug } from '@/lib/menu-catalog';

export interface AiSalesProps {
  activeTab: string;
  activeCompany: CompanySlug;
  userRole?: string;
}

export default function AiSales({ activeTab, activeCompany, userRole }: AiSalesProps) {
  const { isTabAllowed } = useTabAccess();
  const isAdmin = userRole === 'admin';

  // Tab visibility follows the exact same access resolution the sidebar
  // uses — a deep link to a hidden tab can never render its content.
  const tab = isTabAllowed(activeTab) ? activeTab : 'ai-calls';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-2xl border border-violet-200 bg-gradient-to-l from-violet-100/70 to-transparent px-4 py-3 dark:border-violet-900 dark:from-violet-950/40" dir="rtl">
        <Brain size={20} className="text-violet-700 dark:text-violet-300" aria-hidden="true" />
        <div>
          <h1 className="text-sm font-black text-violet-900 dark:text-violet-100">هوش مصنوعی فروش</h1>
          <p className="text-[11px] text-violet-700/70 dark:text-violet-300/70">تحلیل مکالمات، اقدام بعدی هوشمند، کوچینگ و حافظه مشتری</p>
        </div>
      </div>

      {tab === 'ai-dashboard' && <AiDashboard companySlug={activeCompany} isAdmin={isAdmin} />}
      {tab === 'ai-calls' && <AiCalls companySlug={activeCompany} />}
      {tab === 'ai-actions' && <AiActions companySlug={activeCompany} />}
      {tab === 'ai-coaching' && <AiCoaching companySlug={activeCompany} isAdmin={isAdmin} />}
      {tab === 'ai-playbook' && <AiPlaybook companySlug={activeCompany} isAdmin={isAdmin} />}
      {tab === 'ai-settings' && <AiSettings companySlug={activeCompany} isAdmin={isAdmin} />}
    </div>
  );
}
