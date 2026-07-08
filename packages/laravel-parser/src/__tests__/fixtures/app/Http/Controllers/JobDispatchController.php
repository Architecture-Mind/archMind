<?php

namespace App\Http\Controllers;

use App\Jobs\ProcessPaymentJob;
use App\Jobs\SendInvoiceJob;
use App\Jobs\NotifyWarehouseJob;
use App\Actions\ArchiveOrderAction;
use App\Events\OrderCreated;
use App\Actions\ExportOrderAction;
use App\Http\Requests\StoreOrderRequest;
use App\Models\Order;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Bus;

class JobDispatchController
{
    /**
     * QUEUE-JOB-001: Job and event dispatches outside DB::transaction().
     */
    public function store(StoreOrderRequest $request): JsonResponse
    {
        $order = Order::create($request->validated());

        // Static dispatch — should emit ir:queue_job
        ProcessPaymentJob::dispatch($order);

        // Global helper — should emit ir:queue_job
        dispatch(new SendInvoiceJob($order->id));

        // Event dispatch outside transaction — should emit ir:event_dispatch
        OrderCreated::dispatch($order);

        // Bus facade dispatch — dispatched class is the argument, not "Bus"
        Bus::dispatch(new NotifyWarehouseJob($order->id));

        // laravel-actions execute-inline pattern — should emit ir:queue_job
        ExportOrderAction::run($order);

        // Direct class dispatchSync() — the DestroyContact::dispatchSync() case
        // from real-repo blind test (Monica) — should emit ir:queue_job
        ArchiveOrderAction::dispatchSync($order);

        return response()->json($order, 201);
    }
}
