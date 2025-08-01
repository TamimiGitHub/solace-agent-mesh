/**
 * Helper function to format file size
 * @param bytes 
 * @param decimals 
 */
export const formatBytes = (bytes: number, decimals = 2): string => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
};

/**
 * Helper function to format date (relative time)
 * @param dateString 
 */
export const formatRelativeTime = (dateString: string): string => {
    try {
        const date = new Date(dateString);
        const now = new Date();
        const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
        const diffInMinutes = Math.floor(diffInSeconds / 60);
        const diffInHours = Math.floor(diffInMinutes / 60);
        const diffInDays = Math.floor(diffInHours / 24);

        if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
        if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
        if (diffInHours < 24) return `${diffInHours}h ago`;
        if (diffInDays === 1) return `Yesterday`;
        if (diffInDays < 7) return `${diffInDays}d ago`;
        return date.toLocaleDateString();
    } catch (e) {
        console.error("Error formatting date:", e);
        return dateString;
    }
};

/**
 * Helper function to format ISO timestamp
 * @param isoString 
 */
export const formatTimestamp = (isoString?: string | null): string => {
    if (!isoString) return "N/A";
    try {
        return new Date(isoString).toLocaleString();
    } catch {
        return "N/A";
    }
};
