<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\JsonResponse;

class UserController
{
    public function destroy(User $user): JsonResponse
    {
        $user->apiTokens()->delete();
        return response()->json(['deleted' => true]);
    }

    public function show(User $user): JsonResponse
    {
        $tokens = $user->apiTokens()->get();
        return response()->json($tokens);
    }
}
