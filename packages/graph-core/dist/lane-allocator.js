export class LaneAllocator {
    // Each index is a lane; value is the SHA currently owning it (or null if free).
    activeLanes = [];
    // Maps a SHA to the lane that has been reserved for it by one of its children.
    reserved = new Map();
    /**
     * Assign a lane to the given commit SHA, given its parent SHAs.
     * Returns the lane index assigned to this commit.
     */
    assignLane(sha, parentShas) {
        // Step 1: Check if a child already reserved a lane for this SHA.
        let lane = this.reserved.get(sha);
        if (lane !== undefined) {
            // Use the reserved lane. Remove the reservation and mark the lane as owned.
            this.reserved.delete(sha);
            this.activeLanes[lane] = sha;
        }
        else {
            // Step 2: Find the first free lane or append a new one.
            lane = this.activeLanes.indexOf(null);
            if (lane === -1) {
                lane = this.activeLanes.length;
                this.activeLanes.push(sha);
            }
            else {
                this.activeLanes[lane] = sha;
            }
        }
        // Step 3: Reserve the current lane for the first parent so it continues straight down.
        if (parentShas.length > 0) {
            const firstParent = parentShas[0];
            // Only reserve if the first parent doesn't already have a reservation.
            if (!this.reserved.has(firstParent)) {
                this.reserved.set(firstParent, lane);
                // Keep the lane "occupied" by the first parent in activeLanes so it
                // won't be allocated to an unrelated commit while we wait for the parent.
                this.activeLanes[lane] = firstParent;
            }
            else {
                // The first parent already has a reservation from another child — free this lane.
                this.activeLanes[lane] = null;
            }
        }
        else {
            // Step 5: No parents — free the lane immediately.
            this.activeLanes[lane] = null;
        }
        // Step 4: Additional (merge) parents do NOT get lane reservations here.
        // They will receive their own lane when they are naturally encountered, unless
        // another earlier child has already reserved one for them.
        return lane;
    }
    /** Return the current lane index reserved or active for a given SHA, if any. */
    currentLane(sha) {
        const reserved = this.reserved.get(sha);
        if (reserved !== undefined)
            return reserved;
        const active = this.activeLanes.indexOf(sha);
        return active === -1 ? undefined : active;
    }
    snapshot() {
        return { activeLanes: [...this.activeLanes] };
    }
    restore(snapshot) {
        this.activeLanes = [...snapshot.activeLanes];
        // Rebuild the reserved map from the activeLanes snapshot: any SHA still sitting
        // in activeLanes at restore time is "reserved" for that lane.
        this.reserved = new Map();
        for (let i = 0; i < this.activeLanes.length; i++) {
            const sha = this.activeLanes[i];
            if (sha !== null) {
                this.reserved.set(sha, i);
            }
        }
    }
}
//# sourceMappingURL=lane-allocator.js.map