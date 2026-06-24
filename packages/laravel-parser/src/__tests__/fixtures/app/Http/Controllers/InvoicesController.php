<?php

namespace App\Http\Controllers;

use App\Http\Resources\InvoiceResource;
use App\Models\Invoice;

class InvoicesController extends Controller
{
    public function show(Invoice $invoice)
    {
        return new InvoiceResource($invoice);
    }
}
