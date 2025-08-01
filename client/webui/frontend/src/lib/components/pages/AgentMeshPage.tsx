import { useState } from "react";

import { Header, LayoutSelector, MessageBanner } from "@/lib/components";
import { AgentMeshCards } from "@/lib/components/agents/AgentMeshCards";
import { useAgents } from "@/lib/hooks";
import { pluginRegistry } from "@/lib/plugins";
import { LayoutType } from "@/lib/types";

export function AgentMeshPage() {
    const { agents, isLoading, error } = useAgents();
    const [currentLayout, setCurrentLayout] = useState<string>("cards");

    if (isLoading) {
        return (
            <div className="space-y-6">
                <div className="flex h-96 items-center justify-center">
                    <div>Loading agents...</div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="space-y-6">
                <div className="flex h-96 items-center justify-center">
                    <MessageBanner variant="error" message={`Error loading agents. ${error}`} />
                </div>
            </div>
        );
    }

    const renderLayoutContent = () => {
        if (currentLayout === LayoutType.CARDS) {
            return <AgentMeshCards agents={agents} />;
        }

        // For other layouts, check if the layout exists in the registry
        const layoutPlugin = pluginRegistry.getPluginById(currentLayout);
        if (layoutPlugin) {
            return layoutPlugin.render({ agents });
        } else {
            console.warn(`Layout ${currentLayout} not found, falling back to cards layout`);
            return <AgentMeshCards agents={agents} />;
        }
    };

    return (
        <div className="flex h-full w-full flex-col">
            <Header title="Agents" />
            <div className={`relative flex-1 p-4 ${
                currentLayout === LayoutType.CARDS ? "" : "bg-[var(--muted)] dark:bg-[var(--color-bg-wMain)]"
            }`}>
                <div className="absolute right-8 z-20 flex items-center space-x-4">
                    <LayoutSelector currentLayout={currentLayout} onLayoutChange={setCurrentLayout} />
                </div>
                {renderLayoutContent()}
            </div>
        </div>
    );
}
