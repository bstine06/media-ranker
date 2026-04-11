export function mergeRefs<T>(...refs: React.Ref<T>[]) {
    return (el: T | null) => {
        for (const ref of refs) {
            if (typeof ref === "function") ref(el);
            else if (ref) (ref as React.MutableRefObject<T | null>).current = el;
        }
    };
}