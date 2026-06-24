<?php

namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class InvoiceResource extends JsonResource
{
    public function toArray($request): array
    {
        return [
            'id'               => $this->id,
            'invoice_date'     => $this->invoice_date,
            'due_date'         => $this->due_date,
            'invoice_number'   => $this->invoice_number,
            'status'           => $this->status,
            'paid_status'      => $this->paid_status,
            'sub_total'        => $this->sub_total,
            'total'            => $this->total,
            'due_amount'       => $this->due_amount,
            'unique_hash'      => $this->unique_hash,
            'invoice_pdf_url'  => $this->invoice_pdf_url,
            'customer_id'      => $this->customer_id,
        ];
    }
}
