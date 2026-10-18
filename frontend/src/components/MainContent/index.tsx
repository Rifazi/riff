'use client';

import React from 'react';
import { Menu } from 'lucide-react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePhone } from '@/hooks/usePhone';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  const { isCollapsed, toggleCollapse } = useSidebar();
  const phone = usePhone();

  if (phone) {
    // The drawer replaces the sidebar column. `--phone-bar` is the top bar's
    // height; `Page` subtracts it so a screen still fills exactly the rest.
    return (
      <main className="min-w-0 w-full flex-1 overflow-hidden [--phone-bar:calc(3rem+env(safe-area-inset-top))]">
        <div className="flex h-[var(--phone-bar)] items-center gap-2 border-b border-border bg-background px-2 pt-[env(safe-area-inset-top)]">
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label="Open menu"
            className="flex h-10 w-10 items-center justify-center rounded-md text-foreground active:bg-muted"
          >
            <Menu className="h-6 w-6" />
          </button>
          <span className="font-semibold">Riff</span>
        </div>
        <div className="min-w-0 w-full max-w-full overflow-hidden">{children}</div>
      </main>
    );
  }

  return (
    <main
      className={`flex-1 min-w-0 overflow-hidden transition-all duration-300 ${
        isCollapsed ? 'ml-16' : 'ml-64'
      }`}
    >
      <div className="pl-8 min-w-0 w-full max-w-full overflow-hidden">{children}</div>
    </main>
  );
};

export default MainContent;
