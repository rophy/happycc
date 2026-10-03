// Node's runtime has WebAssembly, but @types/node 20 does not declare it and this
// package does not load the DOM lib. The PGlite loaders only pass the compiled
// module through, so an opaque type is enough.
declare namespace WebAssembly {
    interface Module {}
}
