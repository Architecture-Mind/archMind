<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class UserController
{
    public function destroy(User $user): JsonResponse
    {
        // Outside any transaction — must NOT be reported as wrapped (IR v1.5 Phase 3).
        $user->apiTokens()->delete();

        // Inside a transaction — must be reported as wrapped.
        DB::transaction(function () use ($user) {
            AuditLog::create(['action' => 'user_deleted', 'user_id' => $user->id]);
        });

        return response()->json(['deleted' => true]);
    }

    public function show(User $user): JsonResponse
    {
        $tokens = $user->apiTokens()->get();
        return response()->json($tokens);
    }
}
