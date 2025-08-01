import React, { useMemo, useState } from "react";

import { ArrowDown, ArrowLeft, Ellipsis, FileText } from "lucide-react";

import { Button } from "@/lib/components";
import { useChatContext } from "@/lib/hooks";
import type { ArtifactInfo } from "@/lib/types";

import { ArtifactCard } from "./ArtifactCard";
import { ArtifactDeleteDialog } from "./ArtifactDeleteDialog";
import { ArtifactPreviewContent } from "./ArtifactPreviewContent";
import { SortOption, SortPopover, type SortOptionType } from "./ArtifactSortPopover";
import { MorePopover } from "./ArtifactMorePopover";
import { ArtifactDeleteAllDialog } from "./ArtifactDeleteAllDialog";

const sortFunctions: Record<SortOptionType, (a1: ArtifactInfo, a2: ArtifactInfo) => number> = {
    [SortOption.NameAsc]: (a1, a2) => a1.filename.localeCompare(a2.filename),
    [SortOption.NameDesc]: (a1, a2) => a2.filename.localeCompare(a1.filename),
    [SortOption.DateAsc]: (a1, a2) => (a1.last_modified > a2.last_modified ? 1 : -1),
    [SortOption.DateDesc]: (a1, a2) => (a1.last_modified < a2.last_modified ? 1 : -1),
};

export const ArtifactPanel: React.FC = () => {
    const { artifacts, previewArtifact, setPreviewArtifact } = useChatContext();

    const [sortOption, setSortOption] = useState<SortOptionType>(SortOption.DateDesc);
    const sortedArtifacts = useMemo(() => {
        return artifacts ? [...artifacts].sort(sortFunctions[sortOption]) : [];
    }, [artifacts, sortOption]);

    const header = useMemo(() => {
        if (previewArtifact) {
            return (
                <div className="flex items-center gap-2 border-b p-2">
                    <Button variant="ghost" onClick={() => setPreviewArtifact(null)}>
                        <ArrowLeft />
                    </Button>
                    <div className="text-md font-semibold">Preview</div>
                </div>
            );
        }
        
        return (
            sortedArtifacts.length > 0 && (
                <div className="flex items-center justify-end border-b p-2">
                    <SortPopover key="sort-popover" currentSortOption={sortOption} onSortChange={setSortOption}>
                        <Button variant="ghost" title="Sort By">
                            <ArrowDown className="h-5 w-5" />
                            <div>Sort By</div>
                        </Button>
                    </SortPopover>
                    <MorePopover key="more-popover">
                        <Button variant="ghost" tooltip="More" >
                            <Ellipsis className="h-5 w-5" />
                        </Button>
                    </MorePopover>
                </div>
            )
        );
    }, [previewArtifact, sortedArtifacts.length, sortOption, setPreviewArtifact]);

    return (
        <div className="flex h-full flex-col">
            {header}

            {/* Panel Content */}
            <div className="flex min-h-0 flex-1">
                {!previewArtifact && (
                    <div className="flex-1 overflow-y-auto">
                        {sortedArtifacts.map(artifact => (
                            <ArtifactCard key={artifact.filename} artifact={artifact} />
                        ))}
                        {artifacts.length === 0 && (
                            <div className="flex h-full items-center justify-center p-4">
                                <div className="text-muted-foreground text-center">
                                    <FileText className="mx-auto mb-4 h-12 w-12" />
                                    <div className="text-lg font-medium">Files</div>
                                    <div className="mt-2 text-sm">No files available</div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                {previewArtifact && (
                    <div className="flex flex-1 flex-col gap-2 min-h-0 min-w-0">
                        <ArtifactCard key={previewArtifact.filename} artifact={previewArtifact} isPreview={true} />
                        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
                            <ArtifactPreviewContent artifact={previewArtifact} />
                        </div>
                    </div>
                )}
            </div>

            {/* Delete Modals */}
            <ArtifactDeleteDialog />
            <ArtifactDeleteAllDialog />
        </div>
    );
};
