<?php

namespace App\Http\Controllers;

use App\Models\Order;
use App\Models\Payment;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class OrderController extends Controller
{
    public function store(Request $request)
    {
        DB::transaction(function () use ($request) {
            $order   = Order::create($request->validated());
            $payment = Payment::create(['order_id' => $order->id, 'amount' => $order->total]);
        });

        return response()->json(['created' => true], 201);
    }
}
