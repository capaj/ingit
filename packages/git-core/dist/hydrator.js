function parsePersonLine(line) {
    // Format: "Name <email> timestamp timezone"
    const match = line.match(/^(.*?)\s+<([^>]*)>\s+(\d+)\s+[+-]\d{4}$/);
    if (match) {
        return {
            name: match[1] ?? '',
            email: match[2] ?? '',
            unix: parseInt(match[3] ?? '0', 10),
        };
    }
    // Fallback: try to extract what we can
    const emailMatch = line.match(/<([^>]*)>/);
    const tsMatch = line.match(/>\s+(\d{9,})/);
    const nameMatch = line.match(/^(.*?)\s*</);
    return {
        name: nameMatch ? nameMatch[1].trim() : line,
        email: emailMatch ? emailMatch[1] : '',
        unix: tsMatch ? parseInt(tsMatch[1], 10) : 0,
    };
}
export class CommitHydrator {
    catFile;
    constructor(catFile) {
        this.catFile = catFile;
    }
    async hydrateCommit(sha) {
        const obj = await this.catFile.contents(sha);
        if (!obj) {
            throw new Error(`Commit object not found: ${sha}`);
        }
        const raw = obj.data.toString('utf8');
        const lines = raw.split('\n');
        let tree = '';
        const parents = [];
        let authorLine = '';
        let committerLine = '';
        let headerDone = false;
        let messageStart = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!headerDone) {
                if (line === '') {
                    headerDone = true;
                    messageStart = i + 1;
                    continue;
                }
                if (line.startsWith('tree ')) {
                    tree = line.slice(5).trim();
                }
                else if (line.startsWith('parent ')) {
                    parents.push(line.slice(7).trim());
                }
                else if (line.startsWith('author ')) {
                    authorLine = line.slice(7);
                }
                else if (line.startsWith('committer ')) {
                    committerLine = line.slice(10);
                }
                // skip other headers (encoding, mergetag, gpgsig, etc.)
            }
        }
        const messageLines = messageStart >= 0 ? lines.slice(messageStart) : [];
        // Trim trailing empty lines
        while (messageLines.length > 0 && messageLines[messageLines.length - 1]?.trim() === '') {
            messageLines.pop();
        }
        const subject = messageLines[0] ?? '';
        const bodyLines = messageLines.slice(1);
        // Remove leading blank line between subject and body if present
        while (bodyLines.length > 0 && bodyLines[0]?.trim() === '') {
            bodyLines.shift();
        }
        const body = bodyLines.join('\n');
        const author = parsePersonLine(authorLine);
        const committer = parsePersonLine(committerLine);
        return {
            sha,
            parents,
            authorName: author.name,
            authorEmail: author.email,
            authorUnix: author.unix,
            committerName: committer.name,
            committerEmail: committer.email,
            committerUnix: committer.unix,
            subject,
            body,
            treeSha: tree,
            refs: [],
        };
    }
}
//# sourceMappingURL=hydrator.js.map