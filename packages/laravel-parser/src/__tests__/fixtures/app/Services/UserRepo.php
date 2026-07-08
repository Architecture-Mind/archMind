<?php

namespace App\Services;

use App\Models\User;
use App\Exceptions\NotifyException;
use App\Services\OwnershipTransferrer;

class UserRepo
{
    public function __construct(
        private OwnershipTransferrer $ownership,
    ) {}

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

    // Real BookStack shape: the caller (UserController::deleteWithTransfer)
    // reads the request param and passes it as an argument here — the
    // if/else branches on THIS method's own parameter, not on a
    // $request->input() call this method never makes (IR v1.5 Phase 6,
    // cross-method extension).
    public function destroyAndTransfer(User $user, ?int $transferToId = null): void
    {
        if (!empty($transferToId)) {
            $this->ownership->reassignTasks($user, $transferToId);
        } else {
            $this->ownership->nullifyOwnership($user);
        }
    }
}
