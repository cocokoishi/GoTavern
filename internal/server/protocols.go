package server

import (
	"math"
	"net"
	"reflect"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

// ProtocolAvailability is the interface-address information used by the
// pinned ServerStartup when one or both protocol settings are "auto".
type ProtocolAvailability struct {
	IPv4Any   bool
	IPv4Local bool
	IPv6Any   bool
	IPv6Local bool
}

// ProtocolSelection is the pair of listener families the pinned startup
// logic selected before binding sockets.
type ProtocolSelection struct {
	UseIPv4 bool
	UseIPv6 bool
}

// ProtocolSelectionError carries one of the pinned startup fatal messages.
type ProtocolSelectionError struct {
	Message string
}

func (e ProtocolSelectionError) Error() string { return e.Message }

// DetectProtocolAvailability mirrors util.getHasIP() for interface addresses.
func DetectProtocolAvailability(addresses []net.Addr) ProtocolAvailability {
	var availability ProtocolAvailability
	for _, address := range addresses {
		var ip net.IP
		switch typed := address.(type) {
		case *net.IPNet:
			ip = typed.IP
		case *net.IPAddr:
			ip = typed.IP
		default:
			continue
		}
		if ipv4 := ip.To4(); ipv4 != nil {
			availability.IPv4Any = true
			if ipv4.Equal(net.IPv4(127, 0, 0, 1).To4()) {
				availability.IPv4Local = true
			}
			continue
		}
		if ip.To16() != nil {
			availability.IPv6Any = true
			if ip.Equal(net.IPv6loopback) {
				availability.IPv6Local = true
			}
		}
	}
	return availability
}

// ResolveProtocolSelection ports ServerStartup.start()'s protocol flags and
// auto-detection branches. addresses must be the current system interfaces,
// or a captured interface set for a deterministic reference comparison.
func ResolveProtocolSelection(options commandline.ServerOptions, addresses []net.Addr) (ProtocolSelection, error) {
	useIPv6 := options.EnableIPv6 == true
	useIPv4 := options.EnableIPv4 == true
	autoIPv6 := options.EnableIPv6 == "auto"
	autoIPv4 := options.EnableIPv4 == "auto"
	if autoIPv6 || autoIPv4 {
		available := DetectProtocolAvailability(addresses)
		hasIPv6 := available.IPv6Any
		hasIPv4 := available.IPv4Any
		if !jsProtocolTruthy(options.Listen) {
			hasIPv6 = available.IPv6Local
			hasIPv4 = available.IPv4Local
		}
		if autoIPv6 {
			useIPv6 = hasIPv6
		}
		if autoIPv4 {
			useIPv4 = hasIPv4
		}
		if autoIPv6 && autoIPv4 && !hasIPv6 && !hasIPv4 {
			return ProtocolSelection{}, ProtocolSelectionError{Message: "Both IPv6 and IPv4 are not detected"}
		}
	}
	if !useIPv6 && !useIPv4 {
		return ProtocolSelection{}, ProtocolSelectionError{Message: "Both IPv6 and IPv4 are disabled or not detected"}
	}
	return ProtocolSelection{UseIPv4: useIPv4, UseIPv6: useIPv6}, nil
}

func jsProtocolTruthy(value any) bool {
	if value == nil {
		return false
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Bool:
		return reflected.Bool()
	case reflect.String:
		return reflected.String() != ""
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return reflected.Int() != 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return reflected.Uint() != 0
	case reflect.Float32, reflect.Float64:
		value := reflected.Float()
		return value != 0 && !math.IsNaN(value)
	default:
		return true
	}
}
