import React, { useImperativeHandle } from "react";

import { ArrowDown } from "lucide-react";

import { Button, useAutoScroll } from "@/lib/components/ui";
import { CHAT_STYLES } from "./chatStyles";

interface ChatMessageListProps extends React.HTMLAttributes<HTMLDivElement> {
    smooth?: boolean;
}
export interface ChatMessageListRef {
    scrollToBottom: () => void;
}

const ChatMessageList = React.forwardRef<ChatMessageListRef, ChatMessageListProps>(({ className = "", children, ...props }, ref) => {
    const {
        scrollRef,
        isAtBottom,
        disableAutoScroll,
        scrollToBottom,
    } = useAutoScroll({
        smooth: true,
        content: children,
    });


    useImperativeHandle(ref, () => ({
        scrollToBottom
    }));
    
    return (
        <div className={`fade-both-mask min-h-0 flex-1 py-3 relative h-full w-full ${className}`}>
            <div className="flex h-full w-full flex-col overflow-y-auto p-4" ref={scrollRef} onWheel={disableAutoScroll} onTouchMove={disableAutoScroll} {...props} style={{
                scrollBehavior: "smooth"
            }}>
                <div className="flex flex-col gap-6" style={CHAT_STYLES}>{children}</div>
            </div>

            {!isAtBottom && (
                <Button
                    onClick={() => {
                        scrollToBottom();
                    }}
                    size="icon"
                    variant="outline"
                    className="absolute bottom-2 left-1/2 z-20 inline-flex -translate-x-1/2 transform rounded-full shadow-md bg-background"
                    aria-label="Scroll to bottom"
                >
                    <ArrowDown className="h-4 w-4" />
                </Button>
            )}
        </div>
    );
});

ChatMessageList.displayName = "ChatMessageList";

export { ChatMessageList };
