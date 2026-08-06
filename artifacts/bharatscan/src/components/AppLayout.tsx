import { Sidebar } from "@/components/Sidebar";
import { GlobalHeader } from "@/components/GlobalHeader";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex-1 min-w-0 ml-14 flex flex-col overflow-hidden">
        <GlobalHeader />
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="max-w-[1500px] w-full mx-auto">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
