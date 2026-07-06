<?php

namespace App\Services;

use App\Models\User;
use App\Exceptions\NotifyException;

class UserRepo
{
    public function destroy(User $user): void
    {
        $this->ensureDeletable($user);
        $user->apiTokens()->delete();
    }

    // Matches ensureDeletable()'s exact shape — leading if/throw, no other
    // significant logic before it (IR v1.5 Phase 4).
    public function ensureDeletable(User $user): void
    {
        if ($user->isLastAdmin()) {
            throw new NotifyException('Cannot delete the last admin.');
        }

        if ($user->isGuest()) {
            throw new NotifyException('Cannot delete the guest account.');
        }
    }

    // Guard-naming convention, but the guard `if` is not the first statement.
    public function verifyOwnership(User $user, int $ownerId): void
    {
        $currentId = $user->id;

        if ($currentId !== $ownerId) {
            throw new NotifyException('Not the owner.');
        }
    }

    // Throw exists but is buried inside a loop, deep in unrelated logic —
    // must NOT be classified as a guard clause (negative case).
    public function processItems(array $items): void
    {
        $count = 0;
        foreach ($items as $item) {
            if ($item->isInvalid()) {
                throw new \RuntimeException('deep throw, not a guard');
            }
            $count++;
        }
    }
}
