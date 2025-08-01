import React from "react";
import { MessageLoading, ViewWorkflowButton } from "@/lib/components/ui";

interface LoadingMessageRowProps {
    statusText?: string;
    onViewWorkflow?: () => void;
}

export const LoadingMessageRow: React.FC<LoadingMessageRowProps> = ({ statusText, onViewWorkflow }) => {
    return (
        <div className="flex h-8 items-center space-x-3 py-1">
            <MessageLoading />
            <div className="flex min-w-0 flex-1 items-center gap-1">
                {statusText && (
                    <span className="text-muted-foreground animate-pulse truncate text-sm" title={statusText}>
                        {statusText}
                    </span>
                )}
                {onViewWorkflow && <ViewWorkflowButton onClick={onViewWorkflow} />}
            </div>
        </div>
    );
};
