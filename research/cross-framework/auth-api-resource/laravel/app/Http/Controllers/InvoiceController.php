<?php
namespace App\Http\Controllers;

use App\Http\Resources\InvoiceResource;

class InvoiceController extends Controller
{
    public function show($id)
    {
        $invoice = \App\Models\Invoice::findOrFail($id);
        return new InvoiceResource($invoice);
    }
}
