<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\UserRepo;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class UserController
{
    public function __construct(
        private UserRepo $userRepo,
    ) {}

    public function destroy(User $user): JsonResponse
    {
        // Guard clause — can abort everything below via throw (IR v1.5 Phase 4).
        $this->userRepo->ensureDeletable($user);

        // Outside any transaction — must NOT be reported as wrapped (IR v1.5 Phase 3).
        $user->apiTokens()->delete();

        // Inside a transaction — must be reported as wrapped.
        DB::transaction(function () use ($user) {
            AuditLog::create(['action' => 'user_deleted', 'user_id' => $user->id]);
        });

        // Durable audit trail — must be classified as ir:audit_log, not a
        // generic ir:service_call (IR v1.5 Phase 5).
        Activity::add(ActivityType::USER_DELETE, $user);

        return response()->json(['deleted' => true]);
    }

    public function show(User $user): JsonResponse
    {
        $tokens = $user->apiTokens()->get();
        return response()->json($tokens);
    }

    // Replicates UserRepo::migrateOwnership()'s exact shape — request param
    // -> if/else -> two different downstream calls (IR v1.5 Phase 6, narrow cut).
    public function migrateOwnership(Request $request, User $user): JsonResponse
    {
        $newOwnerId = $request->input('migrate_ownership_id', null);

        if (!empty($newOwnerId)) {
            $this->userRepo->reassignTasks($user, $newOwnerId);
        } else {
            $this->userRepo->nullifyOwnership($user);
        }

        return response()->json(['migrated' => true]);
    }

    // Replicates BookStack's REAL shape (found via real-repo regression check,
    // not the collapsed single-method fixture above): the controller reads
    // the request param and hands it straight to a service method as an
    // argument — the if/else keyed on it lives one hop away, inside the
    // callee, not in this method (IR v1.5 Phase 6, cross-method extension).
    public function deleteWithTransfer(Request $request, User $user): JsonResponse
    {
        $transferToId = $request->input('transfer_to_id', null);

        $this->userRepo->destroyAndTransfer($user, $transferToId);

        return response()->json(['deleted' => true]);
    }
}
