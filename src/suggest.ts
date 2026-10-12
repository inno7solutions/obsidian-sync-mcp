/** "Did you mean" for a path that doesn't exist: same file name first, then the nearest paths by edit distance. */
export function closestPaths(wanted: string, paths: string[], max = 3): string[] {
    // Compare without ".md", so a missing extension doesn't count as a typo.
    const norm = (p: string) => p.replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
    const want = norm(wanted);
    const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
    const wantName = name(want);
    const limit = Math.max(2, Math.floor(want.length / 4));
    return paths
        .map((p) => {
            const lower = norm(p);
            if (name(lower) === wantName) return { p, d: 0 };
            return { p, d: Math.abs(lower.length - want.length) > limit ? Infinity : distance(lower, want) };
        })
        .filter((x) => x.d <= limit)
        .sort((a, b) => a.d - b.d || a.p.localeCompare(b.p))
        .slice(0, max)
        .map((x) => x.p);
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length];
}
