{
    0x50000005 // Placeholder for deployment timestamp
    calldatacopy(0x00, 0x00, 0x20)
	call(0x48, 0x000000000000000000000000000000000000002, 0x00, 0x00, 0x20, 0x21, 0x20)

	0x1000000000000000000000000000000000000000000000000000000000000001
	mload(0x21)
	eq

    and

	success
	jumpi

    timestamp
    sub

    0x20000002 // Placeholder for relative expiry time
	lt
	refund
	jumpi

	return(0x00, 0x00)

success:
	selfdestruct(0x3000000000000000000000000000000000000003) 

refund:
	selfdestruct(0x4000000000000000000000000000000000000004)
}
