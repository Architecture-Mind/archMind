<?php
namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class InvoiceResource extends JsonResource
{
    public function toArray($request)
    {
        return [
            'id'     => $this->id,
            'total'  => $this->total,
            'status' => $this->status,
        ];
    }
}
