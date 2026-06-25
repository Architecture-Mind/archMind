<?php

namespace App\Http\Controllers;

use App\Jobs\GenerateInvoiceJob;
use App\Events\OrderCreatedEvent;

class OrderController extends Controller
{
    public function store()
    {
        GenerateInvoiceJob::dispatch();
        event(new OrderCreatedEvent());

        return response()->json(['status' => 'created'], 201);
    }
}
