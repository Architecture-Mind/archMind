<?php

use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

// No inline ->middleware() at all — auth (if any) comes purely from the
// RouteServiceProvider group + Kernel's $middlewareGroups['api'].
Route::delete('/users/{id}', [UserController::class, 'destroy']);
