import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

import {  Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const commonButtonStyles =
    "text-[var(--color-primary-wMain)] hover:text-[var(--color-primary-text-w60)] hover:bg-[var(--color-primary-w10)] dark:text-[var(--color-primary-w20)] dark:hover:text-[var(--color-primary-text-w10)] dark:hover:bg-[var(--color-primary-w60)]";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-semibold transition-all disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:hover:bg-transparent dark:disabled:hover:bg-transparent",
    {
        variants: {
            variant: {
                default: "text-[var(--color-primary-text-w10)] bg-[var(--color-primary-wMain)] hover:bg-[var(--color-primary-w100)] dark:hover:bg-[var(--color-primary-w60)]",
                destructive: "text-[var(--color-primary-text-w10)] bg-[var(--color-error-wMain)] hover:bg-[var(--color-error-w70)]",
                outline: commonButtonStyles + " border border-1 border-[var(--color-primary-wMain)]",
                secondary: commonButtonStyles,
                ghost: commonButtonStyles,
                link: "underline-offset-4 hover:underline",
            },
            size: {
                default: "h-9 px-5 py-2 has-[>svg]:px-3",
                sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
                lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
                icon: "size-9",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

function Button({
    className,
    variant,
    size,
    asChild = false,
    tooltip = "",
    ...props
}: React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
        asChild?: boolean;
        tooltip?: string;
    }) {
    const Comp = asChild ? Slot : "button";
    const ButtonComponent = <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;

    if (tooltip) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    {ButtonComponent}
                </TooltipTrigger>
                <TooltipContent>
                    {tooltip}
                </TooltipContent>
            </Tooltip>
        );
    }

    return ButtonComponent;
}

export { Button };
