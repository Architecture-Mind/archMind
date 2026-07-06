<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\UserRepo;
use Illuminate\Http\JsonResponse;
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
}
