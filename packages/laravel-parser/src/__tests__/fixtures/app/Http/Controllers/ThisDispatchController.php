<?php

namespace App\Http\Controllers;

use App\Jobs\ProcessReportJob;
use App\Jobs\RegisterUserJob;
use App\Events\UserRegistered;
use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Foundation\Bus\DispatchesJobs;

class ThisDispatchController extends Controller
{
    use DispatchesJobs;

    /**
     * THIS-DISPATCH-001: $this->dispatch() via DispatchesJobs trait
     */
    public function store(Request $request): JsonResponse
    {
        // $this->dispatch() — member call on $this
        $this->dispatch(new ProcessReportJob($request->user()));

        return response()->json(['ok' => true]);
    }

    /**
     * THIS-DISPATCH-002: $this->dispatchSync() for synchronous dispatch
     */
    public function register(Request $request): JsonResponse
    {
        // $this->dispatchSync() — synchronous dispatch, different method name
        $this->dispatchSync(new RegisterUserJob($request->all()));

        return response()->json(['ok' => true]);
    }
}
